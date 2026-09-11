/**
 * `orch workflow` setup / doctor.
 */

import type { Command } from 'commander';
import type { LightContainer } from '../../container.js';
import { printKeyValue, printError, printSuccess, dim } from '../output.js';
import { detectWslGitnexus } from '../../infrastructure/code-intelligence/cli-runner.js';
import { GitNexusCodeIntelligence } from '../../infrastructure/code-intelligence/gitnexus-adapter.js';

export function registerWorkflowCommand(program: Command, container: LightContainer): void {
  const workflow = program
    .command('workflow')
    .description('Team workflow config (.orch/workflow.yml)');

  workflow
    .command('setup')
    .description('Show how to enable admission, Linear, and GitNexus')
    .option('--analyze', 'Run gitnexus analyze after printing setup hints')
    .action(async (opts: { analyze?: boolean }) => {
      console.log(dim('  Edit .orch/workflow.yml'));
      console.log('  code_admission.enabled: true');
      console.log('  linear.enabled: true   # then: orch integration login');
      console.log('  GitHub: logged-in `gh` is enough locally; GITHUB_TOKEN is only for CI');
      if (detectWslGitnexus()) {
        console.log('  GitNexus: WSL2 detected — ORCH will call `wsl` (supported runtime)');
      } else {
        console.log('  Install gitnexus on Linux/macOS/WSL2, then: orch workflow setup --analyze');
        console.log('  Native Windows is best-effort (LadybugDB FTS often needs OpenSSL/VC++)');
      }
      console.log('  CE methodology: .orch/compound.yml (ORCH stays the scheduler)');
      console.log('  Wiki: orch wiki generate (needs GITNEXUS_WIKI_PROVIDER / GITNEXUS_WIKI_API_KEY or a local CLI provider)');
      console.log('  If GitHub wiki is empty: create the first page once, then orch wiki publish on main');
      if (!opts.analyze) return;
      try {
        const intelligence = new GitNexusCodeIntelligence({
          projectRoot: container.context.projectRoot,
        });
        await intelligence.analyze({ repository_root: container.context.projectRoot });
        printSuccess('GitNexus analyze finished');
        const { WikiService } = await import('../../application/wiki-service.js');
        const wiki = new WikiService(container.context.projectRoot);
        const status = await wiki.status();
        if (status.bootstrap_required) {
          console.log('  Wiki remote: BOOTSTRAP_REQUIRED — create the first GitHub wiki page once.');
        }
        try {
          await wiki.generate();
          printSuccess('GitNexus wiki generate finished');
        } catch (wikiErr) {
          printError(wikiErr instanceof Error ? wikiErr.message : String(wikiErr));
          console.log(dim('  Set GITNEXUS_WIKI_API_KEY or --provider claude/codex/cursor to generate pages.'));
        }
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  workflow
    .command('doctor')
    .description('Summarize workflow configuration')
    .action(() => {
      const cfg = container.workflowConfig;
      printKeyValue([
        ['File', container.workflowConfig ? '.orch/workflow.yml' : 'missing (admission off)'],
        ['Admission', cfg?.code_admission?.enabled ? 'enabled' : 'disabled'],
        ['Linear', cfg?.linear?.enabled ? 'enabled' : 'disabled'],
        ['Council @', String(cfg?.council?.required_task_count ?? 5)],
        ['Ponytail', cfg?.ponytail?.enabled === false ? 'off' : 'on'],
        ['Wiki', cfg?.wiki?.enabled === false ? 'off' : 'on'],
      ]);
    });
}
