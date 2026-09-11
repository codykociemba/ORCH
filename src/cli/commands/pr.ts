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
      await linkPrWithOutbox(container, task, prUrl, Number.isFinite(number) ? number : undefined);
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
      const planLink = await planUnitCompletesIssue(container, task);
      console.log(buildPrBody(task, {
        completesIssue: planLink.completesIssue,
        relatedIssues: planLink.relatedIssues,
      }));
      console.log(`# suggested branch: ${branchHint(task)}`);
    });

  pr
    .command('create <taskId>')
    .description('Open a GitHub PR with Linear ID in the title and Linear magic-word')
    .action(async (taskId: string) => {
      const task = await container.taskStore.get(taskId);
      if (!task) {
        printError(`Task not found: ${taskId}`);
        process.exitCode = 1;
        return;
      }
      const planLink = await planUnitCompletesIssue(container, task);
      const linear = task.external?.linear?.identifier;
      const title = linear ? `${linear}: ${task.title}` : task.title;
      const generateBeforePr = (container.workflowConfig?.wiki as { local?: { generate_before_orch_pr?: boolean } } | undefined)
        ?.local?.generate_before_orch_pr !== false;
      if (generateBeforePr) {
        try {
          const { WikiService } = await import('../../application/wiki-service.js');
          const wiki = new WikiService(container.context.projectRoot);
          container.eventBus.emit({ type: 'wiki:generation_started', mode: 'preview', sha: 'pending' });
          await wiki.generate();
          const status = await wiki.status({ probeRemote: false });
          container.eventBus.emit({
            type: 'wiki:generation_completed',
            mode: 'preview',
            sha: status.source_sha ?? '',
            pages: status.pages_generated,
          });
          console.log(`Wiki preview: ${status.pages_generated} page(s) @ ${(status.source_sha ?? '').slice(0, 7) || 'unknown'}`);
        } catch (wikiErr) {
          container.eventBus.emit({
            type: 'wiki:failed',
            stage: 'generate',
            error: wikiErr instanceof Error ? wikiErr.message : String(wikiErr),
          });
          console.log(`Wiki preview skipped: ${wikiErr instanceof Error ? wikiErr.message : String(wikiErr)}`);
        }
      }
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      const head = await ensureLinearBranch(container.context.projectRoot, task, execFileAsync);
      if (head.warning) console.log(head.warning);
      if (head.renamed || task.proof?.branch !== head.branch) {
        task.proof = { ...task.proof, files_changed: task.proof?.files_changed ?? [], branch: head.branch };
        task.updated_at = new Date().toISOString();
        await container.taskStore.save(task);
        console.log(`Branch: ${head.branch}`);
      }
      try {
        const { stdout } = await execFileAsync('gh', [
          'pr', 'create',
          '--title', title,
          '--body', buildPrBody(task, {
            completesIssue: planLink.completesIssue,
            relatedIssues: planLink.relatedIssues,
          }),
          '--head', head.branch,
        ], { timeout: 30_000, windowsHide: true });
        const url = stdout.trim().split('\n').find((line) => line.includes('http')) ?? stdout.trim();
        const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
        await linkPrWithOutbox(container, task, url, Number.isFinite(number) ? number : undefined);
        printSuccess(url);
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}

/** Spec §7.4: persist the HEAD-bound proof snapshot and update the GitHub proof comment. */
async function publishPrProofSnapshot(
  container: LightContainer,
  task: import('../../domain/task.js').Task,
): Promise<void> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    let headSha = '';
    try {
      const ref = task.proof?.branch?.trim() || 'HEAD';
      const { stdout } = await execFileAsync('git', ['rev-parse', ref], {
        cwd: container.context.projectRoot,
        timeout: 10_000,
        windowsHide: true,
      });
      headSha = stdout.trim();
    } catch {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
        cwd: container.context.projectRoot,
        timeout: 10_000,
        windowsHide: true,
      });
      headSha = stdout.trim();
    }
    if (!headSha) return;
    const { WikiService } = await import('../../application/wiki-service.js');
    const wiki = container.workflowConfig?.wiki?.enabled === false
      ? undefined
      : await new WikiService(container.context.projectRoot).evidence('pr-preview');
    const { ReviewStore } = await import('../../infrastructure/storage/review-store.js');
    const reviews = await new ReviewStore(container.paths).list(task.id);
    const audit = container.codeAdmissionService.enabled()
      ? await container.codeAdmissionService.auditTask(task)
      : undefined;
    const contract = container.codeAdmissionService.enabled()
      ? await container.codeAdmissionService.getContract(task.id) ?? undefined
      : undefined;
    const { ProofService } = await import('../../application/proof-service.js');
    const conventionRules = (container.workflowConfig as { conventions?: {
      enabled?: boolean;
      organization?: Record<string, unknown>;
      comments?: Record<string, unknown>;
    } } | null)?.conventions;
    const conventionFiles = conventionRules?.enabled === false
      ? undefined
      : await (await import('./proof.js')).collectConventionDiffs(
        container.context.projectRoot,
        task.proof?.files_changed ?? [],
        task.proof?.branch,
      );
    const evidence = new ProofService().build({
      task,
      audit,
      contract,
      headSha,
      reviews: reviews.length > 0 ? reviews : task.reviews,
      reviewPolicy: (await import('../../application/review-policy.js')).resolveReviewPolicy(
        task,
        container.workflowConfig?.review as {
          policy?: import('../../application/review-policy.js').ReviewPolicy;
          high_risk_policy?: import('../../application/review-policy.js').ReviewPolicy;
        } | undefined,
        contract,
      ),
      wiki,
      conventionFiles,
      conventionRules,
    });
    if (evidence.admission && audit) {
      const deps = new Set<string>();
      for (const item of audit.violations) {
        if (item.kind === 'unapproved_dependency' && item.name) deps.add(item.name);
      }
      try {
        const cwd = container.context.projectRoot;
        const ref = task.proof?.branch?.trim();
        let range = 'HEAD';
        if (ref) {
          try {
            const { stdout: base } = await execFileAsync('git', ['merge-base', 'HEAD', ref], {
              cwd,
              timeout: 10_000,
              windowsHide: true,
            });
            range = base.trim() ? `${base.trim()}...${ref}` : ref;
          } catch {
            range = ref;
          }
        }
        const { stdout } = await execFileAsync('git', ['diff', '-U0', range, '--', 'package.json'], {
          cwd,
          timeout: 10_000,
          windowsHide: true,
        });
        for (const line of stdout.split('\n')) {
          const match = /^\+\s*"([^"]+)"\s*:\s*"/.exec(line);
          const pkg = match?.[1];
          if (!pkg || pkg.startsWith('@types/') || pkg === 'name' || pkg === 'version' || pkg === 'description') continue;
          deps.add(pkg);
        }
      } catch {
        // Fail-open: approved_dependencies still render.
      }
      (evidence.admission as { actual_new_dependencies?: string[] }).actual_new_dependencies = [...deps];
    }
    if ((evidence.reviews ?? []).some((review) => (
      (!evidence.head_sha || review.commit_sha === evidence.head_sha)
      && (review.verdict === 'changes_requested' || review.verdict === 'failed')
    ))) {
      evidence.verified = false;
      delete evidence.verified_at;
    }
    const { writeJson } = await import('../../infrastructure/storage/fs-utils.js');
    const { sanitizeId } = await import('../../infrastructure/storage/paths.js');
    const path = await import('node:path');
    await writeJson(
      path.join(container.paths.root, 'proofs', sanitizeId(task.id), `${headSha}.json`),
      evidence,
    );
    if (task.external?.github?.pr_number !== undefined) {
      const { GitHubProofPublisher } = await import('../../infrastructure/proof/github-publisher.js');
      await new GitHubProofPublisher().publish(task, evidence);
      console.log(`Proof snapshot published for ${task.id} @ ${headSha.slice(0, 7)}`);
    }
  } catch (err) {
    console.log(`Proof snapshot skipped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Spec §7.1: rename `orchestry/…` → `orch/ENG-123-slug` before first push when safe. */
async function ensureLinearBranch(
  projectRoot: string,
  task: import('../../domain/task.js').Task,
  execFileAsync: (file: string, args: string[], opts: { cwd?: string; timeout?: number; windowsHide?: boolean }) => Promise<{ stdout: string }>,
): Promise<{ branch: string; renamed: boolean; warning?: string }> {
  const desired = branchHint(task);
  const current = task.proof?.branch?.trim() || '';
  if (!current || current === desired) return { branch: desired, renamed: false };

  const protectedBranch = /^(main|master|develop|HEAD)$/i.test(current);
  if (protectedBranch) {
    return { branch: current, renamed: false, warning: `Kept branch ${current} (will not rename a default branch)` };
  }

  try {
    const { stdout: upstream } = await execFileAsync(
      'git',
      ['for-each-ref', '--format=%(upstream)', `refs/heads/${current}`],
      { cwd: projectRoot, timeout: 10_000, windowsHide: true },
    );
    if (upstream.trim()) {
      return {
        branch: current,
        renamed: false,
        warning: `Kept ${current} — already has a remote tracking branch`,
      };
    }
  } catch {
    // Missing ref is fine; still try the worktree checkout.
  }

  const { sanitizeId } = await import('../../infrastructure/storage/paths.js');
  const path = await import('node:path');
  const worktree = task.workspace ?? path.join(projectRoot, '.orchestry', 'workspaces', sanitizeId(task.id));
  try {
    await execFileAsync('git', ['rev-parse', '--verify', desired], {
      cwd: projectRoot,
      timeout: 10_000,
      windowsHide: true,
    });
    return { branch: desired, renamed: false, warning: `Branch ${desired} already exists — using it for the PR` };
  } catch {
    // Desired name is free.
  }

  try {
    await execFileAsync('git', ['branch', '-m', current, desired], {
      cwd: worktree,
      timeout: 10_000,
      windowsHide: true,
    });
    return { branch: desired, renamed: true };
  } catch {
    try {
      await execFileAsync('git', ['branch', '-m', current, desired], {
        cwd: projectRoot,
        timeout: 10_000,
        windowsHide: true,
      });
      return { branch: desired, renamed: true };
    } catch (err) {
      return {
        branch: current,
        renamed: false,
        warning: `Could not rename ${current} → ${desired}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

async function linkPrWithOutbox(
  container: LightContainer,
  task: import('../../domain/task.js').Task,
  url: string,
  number?: number,
): Promise<void> {
  const branch = task.proof?.branch?.trim();
  if (branch) {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync('git', ['rev-parse', branch], {
        cwd: container.context.projectRoot,
        timeout: 10_000,
        windowsHide: true,
      });
      const sha = stdout.trim();
      if (sha) {
        task.proof = {
          ...task.proof,
          files_changed: task.proof?.files_changed ?? [],
          branch,
          head_sha: sha,
        };
        task.updated_at = new Date().toISOString();
        await container.taskStore.save(task);
      }
    } catch {
      // keep existing proof SHA; Linear Head is omitted if still empty
    }
  }
  const fingerprint = `linear.pr:${task.id}:${url}`;
  const entry = await container.outboxStore.enqueue({
    kind: 'linear.pr',
    task_id: task.id,
    fingerprint,
  });
  try {
    if (entry.status !== 'done') {
      await container.integrationService.linkPullRequest(task, url, number);
      entry.status = 'done';
      delete entry.last_error;
      await container.outboxStore.save(entry);
    }
    await persistGithubMapping(container.paths.root, task.id, url, number);
    const updated = await container.taskStore.get(task.id) ?? task;
    updated.external = {
      ...updated.external,
      github: {
        ...updated.external?.github,
        pr_url: url,
        pr_number: number ?? updated.external?.github?.pr_number,
      },
    };
    const planLink = await planUnitCompletesIssue(container, updated);
    const sharedBranch = updated.proof?.branch?.trim();
    const siblings = sharedBranch || planLink.relatedIssues.length
      ? await container.taskStore.list()
      : [];
    for (const related of planLink.relatedIssues) {
      const other = siblings.find((item) => item.id === related.taskId);
      if (!other) continue;
      const otherBranch = other.proof?.branch?.trim();
      const sameBranch = Boolean(sharedBranch && otherBranch === sharedBranch);
      const samePr = other.external?.github?.pr_url === url;
      if (!sameBranch && !samePr) continue;
      const siblingFingerprint = `linear.pr:${other.id}:${url}`;
      const siblingEntry = await container.outboxStore.enqueue({
        kind: 'linear.pr',
        task_id: other.id,
        fingerprint: siblingFingerprint,
      });
      if (siblingEntry.status !== 'done') {
        await container.integrationService.linkPullRequest(other, url, number);
        siblingEntry.status = 'done';
        delete siblingEntry.last_error;
        await container.outboxStore.save(siblingEntry);
      }
      await persistGithubMapping(container.paths.root, other.id, url, number);
    }
    await publishPrProofSnapshot(container, updated);
  } catch (err) {
    entry.status = 'failed';
    entry.last_error = err instanceof Error ? err.message : String(err);
    await container.outboxStore.save(entry);
    throw err;
  }
}

async function persistGithubMapping(
  orchRoot: string,
  taskId: string,
  url: string,
  number?: number,
): Promise<void> {
  try {
    const path = await import('node:path');
    const { readJson, writeJson } = await import('../../infrastructure/storage/fs-utils.js');
    const file = path.join(orchRoot, 'integrations', 'github', 'mappings.json');
    const current = await readJson<Record<string, { url: string; number?: number }>>(file) ?? {};
    current[taskId] = { url, number };
    await writeJson(file, current);
  } catch {
    // Fail-open: task.external.github remains the live mapping.
  }
}

/** Spec §7.2: only the last open plan unit may close its Linear issue. */
async function planUnitCompletesIssue(
  container: LightContainer,
  task: import('../../domain/task.js').Task,
): Promise<{
  completesIssue: boolean;
  relatedIssues: Array<{ identifier: string; url?: string; taskId: string; completes?: boolean }>;
}> {
  const relatedIssues: Array<{ identifier: string; url?: string; taskId: string; completes?: boolean }> = [];
  if (!task.plan_id) {
    return { completesIssue: true, relatedIssues };
  }
  const { isTerminal } = await import('../../domain/transitions.js');
  const siblings = await container.taskStore.list();
  const seen = new Set<string>();
  let openSiblings = 0;
  for (const other of siblings) {
    if (other.id === task.id || other.plan_id !== task.plan_id) continue;
    if (!isTerminal(other.status)) openSiblings += 1;
    const identifier = other.external?.linear?.identifier?.trim();
    if (!identifier || seen.has(identifier)) continue;
    seen.add(identifier);
    relatedIssues.push({
      identifier,
      url: other.external?.linear?.url,
      taskId: other.id,
      completes: false,
    });
  }
  return {
    completesIssue: !task.plan_unit_id || openSiblings === 0,
    relatedIssues,
  };
}
