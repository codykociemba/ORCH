/**
 * `orch proof` — show / publish verification evidence.
 */

import type { Command } from 'commander';
import type { LightContainer } from '../../container.js';
import { printError } from '../output.js';
import { ProofService } from '../../application/proof-service.js';
import { resolveReviewPolicy, type ReviewPolicy } from '../../application/review-policy.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function registerProofCommand(program: Command, container: LightContainer): void {
  const proof = program
    .command('proof')
    .description('Show or publish verification proof');

  proof
    .command('show <taskId>')
    .description('Render GitHub-style proof for a task')
    .action(async (taskId: string) => {
      const body = await buildProof(container, taskId);
      if (!body) return;
      if (container.context.json) {
        console.log(JSON.stringify(body.evidence, null, 2));
        return;
      }
      console.log(body.markdown);
    });

  proof
    .argument('[taskId]')
    .description('Alias for proof show')
    .action(async (taskId?: string) => {
      if (!taskId) return;
      const body = await buildProof(container, taskId);
      if (!body) return;
      console.log(body.markdown);
    });

  proof
    .command('publish <taskId>')
    .description('Publish proof to Linear and/or GitHub PR, bound to HEAD SHA')
    .option('--github', 'Also comment on the linked GitHub PR via gh')
    .action(async (taskId: string, opts: { github?: boolean }) => {
      const body = await buildProof(container, taskId);
      if (!body) return;
      const task = await container.taskStore.get(taskId);
      if (!task) return;
      let published = false;
      if (container.integrationService.enabled()) {
        const fingerprint = `linear.proof:${task.id}:${body.evidence.head_sha ?? ''}`;
        const entry = await container.outboxStore.enqueue({
          kind: 'linear.proof',
          task_id: task.id,
          fingerprint,
        });
        try {
          if (entry.status !== 'done') {
            await container.integrationService.publishProof(task, body.evidence);
            entry.status = 'done';
            delete entry.last_error;
            await container.outboxStore.save(entry);
          }
          console.log('Published Linear proof comment');
          published = true;
        } catch (err) {
          entry.status = 'failed';
          entry.last_error = err instanceof Error ? err.message : String(err);
          await container.outboxStore.save(entry);
          throw err;
        }
      }
      if (opts.github || task.external?.github?.pr_number) {
        const { GitHubProofPublisher } = await import('../../infrastructure/proof/github-publisher.js');
        const action = await new GitHubProofPublisher().publish(task, body.evidence);
        console.log(action === 'updated'
          ? 'Updated GitHub PR proof comment for this SHA'
          : 'Published GitHub PR proof comment');
        published = true;
      }
      if (!published) {
        printError('Nothing to publish — enable Linear or link a PR (`orch pr link`)');
        process.exitCode = 1;
      }
    });
}

async function buildProof(container: LightContainer, taskId: string): Promise<{
  evidence: ReturnType<ProofService['build']>;
  markdown: string;
} | null> {
  const task = await container.taskStore.get(taskId);
  if (!task) {
    printError(`Task not found: ${taskId}`);
    process.exitCode = 1;
    return null;
  }
  const audit = container.codeAdmissionService.enabled()
    ? await container.codeAdmissionService.auditTask(task)
    : undefined;
  let headSha: string | undefined;
  try {
    const ref = task.proof?.branch?.trim() || 'HEAD';
    const { stdout } = await execFileAsync('git', ['rev-parse', ref], { cwd: container.context.projectRoot });
    headSha = stdout.trim() || undefined;
  } catch {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: container.context.projectRoot });
      headSha = stdout.trim() || undefined;
    } catch {
      headSha = undefined;
    }
  }
  const { ReviewStore } = await import('../../infrastructure/storage/review-store.js');
  const reviews = await new ReviewStore(container.paths).list(task.id);
  const { WikiService } = await import('../../application/wiki-service.js');
  const wikiService = new WikiService(container.context.projectRoot);
  const wikiStatus = container.workflowConfig?.wiki?.enabled === false
    ? undefined
    : await wikiService.status({ probeRemote: false });
  const wikiMode = !wikiStatus
    ? undefined
    : wikiStatus.can_publish && !wikiStatus.bootstrap_required && wikiStatus.index_current
      ? 'canonical-publish'
      : task.proof?.pr_url
        ? 'pr-preview'
        : 'local-preview';
  const wiki = wikiMode ? await wikiService.evidence(wikiMode) : undefined;
  const contract = container.codeAdmissionService.enabled()
    ? await container.codeAdmissionService.getContract(task.id) ?? undefined
    : undefined;
  const { listLearnings } = await import('../../application/learning-reader.js');
  const learningRefs = task.goalId
    ? (await listLearnings(container.context.projectRoot))
      .filter((note) => note.goal_id === task.goalId)
      .map((note) => note.file)
    : [];
  const service = new ProofService();
  const conventionRules = (container.workflowConfig as { conventions?: {
    enabled?: boolean;
    organization?: Record<string, unknown>;
    comments?: Record<string, unknown>;
  } } | null)?.conventions;
  const conventionFiles = conventionRules?.enabled === false
    ? undefined
    : await collectConventionDiffs(
      container.context.projectRoot,
      task.proof?.files_changed ?? [],
      task.proof?.branch,
    );
  const evidence = service.build({
    task,
    audit,
    contract,
    learningRefs: learningRefs.length > 0 ? learningRefs : undefined,
    headSha,
    reviews: reviews.length > 0 ? reviews : task.reviews,
    reviewPolicy: resolveReviewPolicy(task, reviewConfig(container), contract),
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
          const { stdout: base } = await execFileAsync('git', ['merge-base', 'HEAD', ref], { cwd });
          range = base.trim() ? `${base.trim()}...${ref}` : ref;
        } catch {
          range = ref;
        }
      }
      const { stdout } = await execFileAsync('git', ['diff', '-U0', range, '--', 'package.json'], { cwd });
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
  task.proof = {
    ...task.proof,
    files_changed: task.proof?.files_changed ?? [],
    head_sha: evidence.head_sha,
    verified: evidence.verified,
  };
  task.updated_at = new Date().toISOString();
  await container.taskStore.save(task);
  if (evidence.head_sha) {
    const { writeJson } = await import('../../infrastructure/storage/fs-utils.js');
    const { sanitizeId } = await import('../../infrastructure/storage/paths.js');
    const path = await import('node:path');
    await writeJson(
      path.join(container.paths.root, 'proofs', sanitizeId(task.id), `${evidence.head_sha}.json`),
      evidence,
    );
  }
  return {
    evidence,
    markdown: service.renderGitHub(evidence, {
      linear: task.external?.linear?.identifier,
      linearUrl: task.external?.linear?.url,
    }),
  };
}

function reviewConfig(container: LightContainer): { policy?: ReviewPolicy; high_risk_policy?: ReviewPolicy } | undefined {
  return container.workflowConfig?.review as { policy?: ReviewPolicy; high_risk_policy?: ReviewPolicy } | undefined;
}

/** Spec §3.4: lint the task branch (or claimed files), not a dirty checkout of another ref. */
export async function collectConventionDiffs(
  cwd: string,
  files: string[],
  branch?: string,
): Promise<Array<{ path: string; status: 'added' | 'modified'; content?: string; addedLines?: string[] }>> {
  const diffs: Array<{ path: string; status: 'added' | 'modified'; content?: string; addedLines?: string[] }> = [];
  const ref = branch?.trim();
  let mergeBase = '';
  if (ref) {
    try {
      const { stdout } = await execFileAsync('git', ['merge-base', 'HEAD', ref], { cwd });
      mergeBase = stdout.trim();
    } catch {
      mergeBase = '';
    }
  }
  let claimed = files.filter(Boolean);
  if (claimed.length === 0 && mergeBase && ref) {
    try {
      const { stdout } = await execFileAsync('git', ['diff', '--name-only', `${mergeBase}...${ref}`], { cwd });
      claimed = stdout.trim().split('\n').filter(Boolean);
    } catch {
      claimed = [];
    }
  }
  for (const file of claimed) {
    try {
      if (mergeBase && ref) {
        const { stdout: statusStdout } = await execFileAsync(
          'git',
          ['diff', '--name-status', `${mergeBase}...${ref}`, '--', file],
          { cwd },
        );
        const codeFlag = statusStdout.trim().split(/\s+/)[0] ?? '';
        if (codeFlag.startsWith('D') || !codeFlag) continue;
        if (codeFlag.startsWith('A')) {
          const { stdout: content } = await execFileAsync('git', ['show', `${ref}:${file.replace(/\\/g, '/')}`], { cwd });
          diffs.push({ path: file, status: 'added', content });
          continue;
        }
        const { stdout } = await execFileAsync('git', ['diff', '-U0', `${mergeBase}...${ref}`, '--', file], { cwd });
        diffs.push({
          path: file,
          status: 'modified',
          addedLines: stdout
            .split('\n')
            .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
            .map((line) => line.slice(1)),
        });
        continue;
      }
      const { stdout: status } = await execFileAsync('git', ['status', '--porcelain', '--', file], { cwd });
      const code = status.slice(0, 2);
      if (code.includes('?') || code.includes('A')) {
        const { readFile } = await import('node:fs/promises');
        const path = await import('node:path');
        diffs.push({
          path: file,
          status: 'added',
          content: await readFile(path.join(cwd, file), 'utf8').catch(() => ''),
        });
        continue;
      }
      const { stdout } = await execFileAsync('git', ['diff', '-U0', 'HEAD', '--', file], { cwd });
      diffs.push({
        path: file,
        status: 'modified',
        addedLines: stdout
          .split('\n')
          .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
          .map((line) => line.slice(1)),
      });
    } catch {
      diffs.push({ path: file, status: 'modified', addedLines: [] });
    }
  }
  return diffs;
}
