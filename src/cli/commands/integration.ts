/**
 * `orch integration` status / retry / sync.
 */

import type { Command } from 'commander';
import { execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { LightContainer } from '../../container.js';
import { printError, printKeyValue, printSuccess, dim } from '../output.js';
import {
  clearStoredLinearApiKey,
  probeLinearApiKey,
  resolveLinearApiKey,
  writeStoredLinearApiKey,
} from '../../infrastructure/integrations/linear/linear-issue-tracker.js';

const LINEAR_KEY_SETTINGS = 'https://linear.app/settings/account/security';

export function registerIntegrationCommand(program: Command, container: LightContainer): void {
  const integration = program
    .command('integration')
    .description('Linear / GitHub sync');

  integration
    .command('status')
    .description('Show Linear configuration and pending outbox')
    .action(async () => {
      const pending = await container.outboxStore.list('pending');
      const failed = await container.outboxStore.list('failed');
      printKeyValue([
        ['Linear', container.integrationService.enabled() ? 'configured' : 'off'],
        ['Credential', resolveLinearApiKey() ? 'present (env or ~/.orchestry/linear.token)' : 'missing — orch integration login'],
        ['Required before dispatch', container.integrationService.requiredBeforeDispatch() ? 'yes' : 'no'],
        ['Outbox pending', String(pending.length)],
        ['Outbox failed', String(failed.length)],
      ]);
      for (const entry of [...pending, ...failed]) {
        console.log(`  ${entry.id}  ${entry.kind}  ${entry.status}  ${entry.task_id}  ${dim(entry.last_error ?? '')}`);
      }
    });

  integration
    .command('retry')
    .description('Retry a failed Linear sync')
    .argument('<provider>', 'linear')
    .argument('<taskId>')
    .action(async (provider: string, taskId: string) => {
      if (provider !== 'linear') {
        printError(`Unknown provider: ${provider}`);
        process.exitCode = 1;
        return;
      }
      try {
        const task = await container.integrationService.retry(taskId);
        printSuccess(task.external?.linear?.identifier ?? task.id);
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  integration
    .command('sync <taskId>')
    .description('Create/retry Linear issue for a task')
    .action(async (taskId: string) => {
      const task = await container.taskStore.get(taskId);
      if (!task) {
        printError(`Task not found: ${taskId}`);
        process.exitCode = 1;
        return;
      }
      await container.integrationService.onTaskCreated(task);
      const updated = await container.taskStore.get(taskId);
      printSuccess(updated?.external?.linear?.identifier ?? 'sync attempted');
    });

  integration
    .command('login')
    .description('Store a Linear API key in ~/.orchestry/linear.token (like gh auth login)')
    .option('--token <key>', 'Personal API key (otherwise prompted)')
    .option('--no-browser', 'Do not open Linear API key settings')
    .action(async (opts: { token?: string; browser?: boolean }) => {
      let token = opts.token?.trim() ?? '';
      if (!token) {
        console.log(dim(`  Create a personal API key: ${LINEAR_KEY_SETTINGS}`));
        if (!input.isTTY) {
          printError('Pass --token <key> when stdin is not a TTY');
          process.exitCode = 1;
          return;
        }
        if (opts.browser !== false) openLinearKeySettings();
        const rl = createInterface({ input, output });
        try {
          token = (await rl.question('  Linear API key: ')).trim();
        } finally {
          rl.close();
        }
      }
      if (!token) {
        printError('No Linear API key provided');
        process.exitCode = 1;
        return;
      }
      try {
        const probe = await probeLinearApiKey(token);
        writeStoredLinearApiKey(token);
        printSuccess(`logged in as ${probe.name}`);
        if (probe.teams.length > 0) {
          console.log(dim(`  Teams: ${probe.teams.join(', ')}`));
        }
        if (container.workflowConfig?.linear?.enabled !== true) {
          console.log(dim('  Set linear.enabled: true in .orch/workflow.yml'));
        }
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  integration
    .command('logout')
    .description('Remove the stored Linear API key')
    .action(() => {
      clearStoredLinearApiKey();
      printSuccess('Linear credential removed');
    });
}

function openLinearKeySettings(): void {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', LINEAR_KEY_SETTINGS] : [LINEAR_KEY_SETTINGS];
  execFile(command, args, { windowsHide: true }, () => {
    /* ignore browser-open failures */
  });
}
