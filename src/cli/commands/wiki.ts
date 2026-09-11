/**
 * `orch wiki` — GitNexus wiki generate / preview / publish.
 */

import type { Command } from 'commander';
import type { LightContainer } from '../../container.js';
import { printError, printKeyValue, printSuccess } from '../output.js';
import { WikiService } from '../../application/wiki-service.js';

export function registerWikiCommand(program: Command, container: LightContainer): void {
  const wiki = program
    .command('wiki')
    .description('Generate or publish the GitNexus wiki');

  const service = (): WikiService => new WikiService(container.context.projectRoot);

  wiki
    .command('status')
    .description('Show wiki host and whether publish is allowed')
    .action(async () => {
      const status = await service().status();
      if (container.context.json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }
      printKeyValue([
        ['Host', status.host],
        ['Branch', status.current_branch],
        ['Default', status.default_branch],
        ['Can publish', status.can_publish ? 'yes' : 'no'],
        ['Bootstrap', status.bootstrap_required ? 'required' : 'ok'],
        ['Pages', String(status.pages_generated)],
      ]);
      if (status.bootstrap_required) {
        console.log('  Enable the repository Wiki and create the first GitHub wiki page once.');
      }
    });

  wiki
    .command('generate')
    .description('Run gitnexus wiki (writes .gitnexus/wiki; does not publish)')
    .option('--provider <name>', 'GitNexus LLM provider (claude, codex, cursor, openai, …)')
    .option('--model <name>', 'LLM model')
    .option('--api-key <key>', 'HTTP provider API key')
    .action(async (opts: { provider?: string; model?: string; apiKey?: string }) => {
      const extra: string[] = [];
      if (opts.provider) extra.push('--provider', opts.provider);
      if (opts.model) extra.push('--model', opts.model);
      if (opts.apiKey) extra.push('--api-key', opts.apiKey);
      const result = await service().generate(extra);
      console.log(result.stdout || result.stderr);
    });

  wiki
    .command('preview')
    .description('Run gitnexus wiki preview')
    .action(async () => {
      const result = await service().preview();
      console.log(result.stdout || result.stderr);
    });

  wiki
    .command('publish')
    .description('Publish canonical wiki (default branch only unless --force)')
    .option('--force', 'Override default-branch guard (human only)')
    .action(async (opts: { force?: boolean }) => {
      try {
        const result = await service().publish({ force: opts.force });
        if (result.bootstrap_required) {
          printError('BOOTSTRAP_REQUIRED');
        } else {
          printSuccess('wiki publish requested');
        }
        if (result.stdout) console.log(result.stdout);
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  wiki
    .command('doctor')
    .description('Alias for wiki status')
    .action(async () => {
      const status = await service().status();
      printKeyValue([
        ['Host', status.host],
        ['Can publish', status.can_publish ? 'yes' : 'no'],
        ['Bootstrap', status.bootstrap_required ? 'required' : 'ok'],
      ]);
    });
}
