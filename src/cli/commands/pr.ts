/**
 * `orch pr link` — attach a GitHub PR to a task and Linear issue.
 */

import type { Command } from 'commander';
import type { LightContainer } from '../../container.js';
import { printError, printSuccess } from '../output.js';
import { buildPrBody, branchHint } from '../../infrastructure/github/pr-body.js';

export function registerPrCommand(program: Command, container: LightContainer): void {
  const pr = program
    .command('pr')
    .description('Link GitHub pull requests to ORCH tasks');

  pr
    .command('link <taskId> <prUrl>')
    .description('Store PR URL on the task and notify Linear')
    .action(async (taskId: string, prUrl: string) => {
      const task = await container.taskStore.get(taskId);
      if (!task) {
        printError(`Task not found: ${taskId}`);
        process.exitCode = 1;
        return;
      }
      const number = Number(/\/pull\/(\d+)/.exec(prUrl)?.[1]);
      await container.integrationService.linkPullRequest(
        task,
        prUrl,
        Number.isFinite(number) ? number : undefined,
      );
      printSuccess(`linked ${prUrl}`);
    });

  pr
    .command('body <taskId>')
    .description('Print a PR body with Linear magic-word and ORCH task refs')
    .action(async (taskId: string) => {
      const task = await container.taskStore.get(taskId);
      if (!task) {
        printError(`Task not found: ${taskId}`);
        process.exitCode = 1;
        return;
      }
      console.log(buildPrBody(task));
      console.log(`# suggested branch: ${branchHint(task)}`);
    });

  pr
    .command('create <taskId>')
    .description('Open a GitHub PR with Linear ID in the title and Fixes magic-word')
    .action(async (taskId: string) => {
      const task = await container.taskStore.get(taskId);
      if (!task) {
        printError(`Task not found: ${taskId}`);
        process.exitCode = 1;
        return;
      }
      const linear = task.external?.linear?.identifier;
      const title = linear ? `${linear}: ${task.title}` : task.title;
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      try {
        const { stdout } = await execFileAsync('gh', [
          'pr', 'create',
          '--title', title,
          '--body', buildPrBody(task),
        ], { timeout: 30_000, windowsHide: true });
        const url = stdout.trim().split('\n').find((line) => line.includes('http')) ?? stdout.trim();
        const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
        await container.integrationService.linkPullRequest(task, url, Number.isFinite(number) ? number : undefined);
        printSuccess(url);
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}
