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
        ['Linear', container.workflowConfig?.linear?.enabled === true
          ? (container.integrationService.enabled() ? 'configured' : 'enabled — login required')
          : 'off'],
        ['Credential', resolveLinearApiKey() ? 'present (env or ~/.orchestry/linear.token)' : 'missing — orch integration login'],
        ['Status owner', (container.workflowConfig?.linear as { status_owner?: string } | undefined)?.status_owner ?? 'hybrid'],
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
    .command('drain')
    .description('Replay pending/failed Linear outbox entries')
    .action(async () => {
      const entries = [
        ...await container.outboxStore.list('pending'),
        ...await container.outboxStore.list('failed'),
      ];
      if (entries.length === 0) {
        printSuccess('outbox empty');
        return;
      }
      const { outboxRetryDue } = await import('../../infrastructure/integrations/outbox-store.js');
      for (const entry of entries) {
        if (!entry.kind.startsWith('linear.')) continue;
        if (!outboxRetryDue(entry)) {
          console.log(`  ${entry.task_id} ${entry.kind} waiting on backoff (attempt ${entry.attempts})`);
          continue;
        }
        try {
          if (entry.kind === 'linear.proof' || entry.kind === 'linear.pr') {
            const task = await container.taskStore.get(entry.task_id);
            if (!task) throw new Error(`Task not found: ${entry.task_id}`);
            if (entry.kind === 'linear.proof') {
              await container.integrationService.publishProof(task, {
                task_id: task.id,
                plan_id: task.plan_id,
                plan_unit_id: task.plan_unit_id,
                branch: task.proof?.branch,
                pr_url: task.proof?.pr_url ?? task.external?.github?.pr_url,
                head_sha: task.proof?.head_sha,
                files_changed: task.proof?.files_changed ?? [],
                checks: [],
                reviews: task.reviews ?? [],
                acceptance_criteria: [],
                verified: task.proof?.verified === true,
              });
            } else if (task.external?.github?.pr_url) {
              await container.integrationService.linkPullRequest(
                task,
                task.external.github.pr_url,
                task.external.github.pr_number,
              );
            }
            entry.status = 'done';
            delete entry.last_error;
            await container.outboxStore.save(entry);
            printSuccess(`${entry.task_id} ${entry.kind}`);
            continue;
          }
          const task = await container.integrationService.retry(entry.task_id);
          printSuccess(`${entry.task_id} ${task.external?.linear?.identifier ?? entry.status}`);
        } catch (err) {
          printError(`${entry.task_id}: ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
        }
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
      if (updated?.external?.linear?.identifier) {
        const renamed = await renameWorktreeAfterLinear(container, updated);
        if (renamed) console.log(`  Branch: ${renamed}`);
      }
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

/** Spec §7.1: after Linear create, rename `orchestry/…` → `orch/ENG-123-slug` when safe. */
async function renameWorktreeAfterLinear(
  container: LightContainer,
  task: import('../../domain/task.js').Task,
): Promise<string | undefined> {
  const { worktreeBranchName } = await import('../../infrastructure/workspace/workspace-manager.js');
  const desired = worktreeBranchName(task);
  const current = task.proof?.branch?.trim() ?? '';
  if (!current || current === desired || /^(main|master|develop|HEAD)$/i.test(current)) return undefined;
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const root = container.context.projectRoot;
  try {
    const { stdout: upstream } = await execFileAsync(
      'git',
      ['for-each-ref', '--format=%(upstream)', `refs/heads/${current}`],
      { cwd: root, timeout: 10_000, windowsHide: true },
    );
    if (upstream.trim()) return undefined;
  } catch {
    // Missing ref is fine.
  }
  const { sanitizeId } = await import('../../infrastructure/storage/paths.js');
  const path = await import('node:path');
  const worktree = task.workspace ?? path.join(container.paths.root, 'workspaces', sanitizeId(task.id));
  for (const cwd of [worktree, root]) {
    try {
      await execFileAsync('git', ['rev-parse', '--verify', desired], {
        cwd: root,
        timeout: 10_000,
        windowsHide: true,
      });
      return undefined;
    } catch {
      // Desired name is free.
    }
    try {
      await execFileAsync('git', ['branch', '-m', current, desired], {
        cwd,
        timeout: 10_000,
        windowsHide: true,
      });
      task.proof = { ...task.proof, files_changed: task.proof?.files_changed ?? [], branch: desired };
      task.updated_at = new Date().toISOString();
      await container.taskStore.save(task);
      return desired;
    } catch {
      // Try the next cwd.
    }
  }
  return undefined;
}

function openLinearKeySettings(): void {
  const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', LINEAR_KEY_SETTINGS] : [LINEAR_KEY_SETTINGS];
  execFile(command, args, { windowsHide: true }, () => {
    /* ignore browser-open failures */
  });
}
