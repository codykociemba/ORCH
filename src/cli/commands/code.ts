/**
 * `orch code` — GitNexus search / impact / status. Light container, no PID lock.
 */

import type { Command } from 'commander';
import type { LightContainer } from '../../container.js';
import { printError, printKeyValue, dim } from '../output.js';
import { createGitNexusIntelligence } from '../../infrastructure/code-intelligence/gitnexus-adapter.js';

function createIntelligence(projectRoot: string): {
  intelligence: ReturnType<typeof createGitNexusIntelligence>['intelligence'];
  close: () => Promise<void>;
} {
  const handle = createGitNexusIntelligence(projectRoot);
  return { intelligence: handle.intelligence, close: handle.close };
}

export function registerCodeCommand(program: Command, container: LightContainer): void {
  const code = program
    .command('code')
    .description('Query the GitNexus code graph');

  code
    .command('status')
    .description('Show GitNexus index freshness')
    .action(async () => {
      const { intelligence, close } = createIntelligence(container.context.projectRoot);
      try {
        const status = await intelligence.getRepositoryStatus({
          repository_root: container.context.projectRoot,
        });
        if (container.context.json) {
          console.log(JSON.stringify(status, null, 2));
          return;
        }
        container.eventBus.emit({
          type: status.current ? 'code_intelligence:index_refreshed' : 'code_intelligence:index_stale',
          repo: status.repo,
        });
        const pairs: Array<[string, string]> = [
          ['Repo', status.repo],
          ['Available', status.available ? 'yes' : 'no'],
          ['Current', status.current ? 'yes' : 'no'],
        ];
        if (status.index_commit) pairs.push(['Index', status.index_commit]);
        printKeyValue(pairs);
        for (const reason of status.incomplete_reasons) {
          console.log(`  ${dim(reason)}`);
        }
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      } finally {
        await close();
      }
    });

  code
    .command('analyze')
    .description('Run gitnexus analyze (raises LadybugDB buffer pool if unset)')
    .action(async () => {
      const { intelligence, close } = createIntelligence(container.context.projectRoot);
      try {
        await intelligence.analyze({ repository_root: container.context.projectRoot });
        const status = await intelligence.getRepositoryStatus({
          repository_root: container.context.projectRoot,
        });
        container.eventBus.emit({
          type: status.current ? 'code_intelligence:index_refreshed' : 'code_intelligence:index_stale',
          repo: status.repo,
        });
        if (container.context.json) {
          console.log(JSON.stringify(status, null, 2));
          return;
        }
        printKeyValue([
          ['Repo', status.repo],
          ['Available', status.available ? 'yes' : 'no'],
          ['Current', status.current ? 'yes' : 'no'],
        ]);
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      } finally {
        await close();
      }
    });

  code
    .command('search <query>')
    .alias('query')
    .description('Search existing symbols/files')
    .option('--worktree <path>', 'Worktree to bind')
    .action(async (query: string, opts: { worktree?: string }) => {
      const { intelligence, close } = createIntelligence(container.context.projectRoot);
      try {
        const hits = await intelligence.searchExisting({
          query,
          worktree: opts.worktree ?? container.context.projectRoot,
        });
        if (container.context.json) {
          console.log(JSON.stringify(hits, null, 2));
          return;
        }
        if (hits.length === 0) {
          console.log(dim('  No matches'));
          return;
        }
        for (const hit of hits) {
          console.log(`  ${hit.path}${hit.symbol ? `#${hit.symbol}` : ''}`);
        }
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      } finally {
        await close();
      }
    });

  code
    .command('context <symbol>')
    .description('Show GitNexus context for a named symbol')
    .option('--worktree <path>', 'Worktree to bind')
    .action(async (symbol: string, opts: { worktree?: string }) => {
      const { intelligence, close } = createIntelligence(container.context.projectRoot);
      try {
        const context = await intelligence.getSymbolContext({
          symbol,
          worktree: opts.worktree ?? container.context.projectRoot,
        });
        if (container.context.json) {
          console.log(JSON.stringify(context, null, 2));
          return;
        }
        printKeyValue([
          ['Symbol', context.symbol],
          ['Path', context.path ?? ''],
          ['Kind', context.kind ?? ''],
          ['Callers', String(context.callers.length)],
          ['Callees', String(context.callees.length)],
          ['Processes', context.processes.join(', ') || 'none'],
        ]);
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      } finally {
        await close();
      }
    });

  code
    .command('impact <symbol>')
    .description('Show GitNexus impact for a symbol')
    .option('--worktree <path>', 'Worktree to bind')
    .action(async (symbol: string, opts: { worktree?: string }) => {
      const { intelligence, close } = createIntelligence(container.context.projectRoot);
      try {
        const report = await intelligence.getImpact({
          target: symbol,
          worktree: opts.worktree ?? container.context.projectRoot,
        });
        if (container.context.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        printKeyValue([
          ['Target', report.target],
          ['Risk', report.risk],
          ['Direct', String(report.direct_dependents)],
          ['Total', String(report.total_dependents)],
        ]);
        if (report.unresolved) console.log(`  ${dim('unresolved / unknown risk')}`);
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      } finally {
        await close();
      }
    });

  code
    .command('processes [query]')
    .description('List GitNexus execution processes')
    .option('--worktree <path>', 'Worktree to bind')
    .action(async (query: string | undefined, opts: { worktree?: string }) => {
      const { intelligence, close } = createIntelligence(container.context.projectRoot);
      try {
        const processes = await intelligence.getProcesses({
          query,
          worktree: opts.worktree ?? container.context.projectRoot,
        });
        if (container.context.json) {
          console.log(JSON.stringify(processes, null, 2));
          return;
        }
        if (processes.length === 0) {
          console.log(dim('  No processes'));
          return;
        }
        for (const item of processes) {
          console.log(`  ${item.name}${item.steps.length ? `  ${item.steps.length} steps` : ''}`);
        }
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      } finally {
        await close();
      }
    });

  code
    .command('detect')
    .description('GitNexus detect_changes for the current worktree (fail-closed flags)')
    .option('--worktree <path>', 'Worktree to bind')
    .option('--scope <scope>', 'all|unstaged|staged', 'all')
    .action(async (opts: { worktree?: string; scope?: 'all' | 'unstaged' | 'staged' }) => {
      const { intelligence, close } = createIntelligence(container.context.projectRoot);
      const worktree = opts.worktree ?? container.context.projectRoot;
      try {
        const changes = await intelligence.detectChanges({
          worktree,
          scope: opts.scope ?? 'all',
        });
        if (container.context.json) {
          console.log(JSON.stringify(changes, null, 2));
          return;
        }
        printKeyValue([
          ['Worktree', changes.worktree],
          ['Risk', changes.risk ?? 'unknown'],
          ['Added', String(changes.added_symbols.length)],
          ['Modified', String(changes.modified_symbols.length)],
          ['Deleted', String(changes.deleted_symbols.length)],
          ['Partial', changes.partial ? 'yes' : 'no'],
          ['Truncated', changes.truncated ? 'yes' : 'no'],
        ]);
        if (changes.partial || changes.truncated || changes.degraded) {
          process.exitCode = 1;
        }
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      } finally {
        await close();
      }
    });
}
