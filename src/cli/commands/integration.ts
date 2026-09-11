/**
 * `orch integration` status / retry / sync.
 */

import type { Command } from 'commander';
import type { LightContainer } from '../../container.js';
import { printError, printKeyValue, printSuccess, dim } from '../output.js';

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
}
