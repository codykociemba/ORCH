/**
 * Post ORCH proof as a GitHub PR comment. Bound to evidence.head_sha.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Task } from '../../domain/task.js';
import type { VerificationEvidence } from '../../domain/evidence.js';
import { renderGitHubProof } from './renderers.js';
import { OrchestryError } from '../../domain/errors.js';

const execFileAsync = promisify(execFile);

export class GitHubProofError extends OrchestryError {
  constructor(message: string, hint?: string) {
    super(message, 1, hint);
    this.name = 'GitHubProofError';
  }
}

export function proofCommentMarker(taskId: string, headSha: string): string {
  return `<!-- orch-proof:${taskId}:${headSha} -->`;
}

export class GitHubProofPublisher {
  constructor(
    private readonly run: typeof execFileAsync = execFileAsync,
  ) {}

  async publish(task: Task, evidence: VerificationEvidence): Promise<'posted' | 'updated'> {
    const number = task.external?.github?.pr_number;
    if (!number) {
      throw new GitHubProofError('Task has no GitHub PR number', 'Run: orch pr link <task> <pr-url>');
    }
    if (!evidence.head_sha) {
      throw new GitHubProofError('Proof has no HEAD SHA — cannot publish Verified comment');
    }
    if ((evidence.reviews ?? []).some((review) => (
      review.commit_sha === evidence.head_sha
      && (review.verdict === 'changes_requested' || review.verdict === 'failed')
    ))) {
      evidence.verified = false;
      delete evidence.verified_at;
    }
    let current = '';
    try {
      current = (await this.run('git', ['rev-parse', task.proof?.branch || 'HEAD'], {
        timeout: 10_000,
        windowsHide: true,
      })).stdout.trim();
    } catch {
      current = '';
    }
    if (evidence.verified && current && current !== evidence.head_sha) {
      evidence.verified = false;
      delete evidence.verified_at;
    }
    const marker = proofCommentMarker(task.id, evidence.head_sha);
    const deleted = task.feedback
      ?.split('\n')
      .find((line) => /^admission: deleted symbols:/i.test(line))
      ?.replace(/^admission: deleted symbols:\s*/i, '')
      .trim();
    const extra = evidence.admission as {
      admission_requests?: string[];
      repo?: string;
      worktree?: string;
    } | undefined;
    const body = [
      marker,
      renderGitHubProof(evidence, {
        linear: task.external?.linear?.identifier,
        linearUrl: task.external?.linear?.url,
      }),
      deleted ? `Deleted symbols: ${deleted}` : '',
      extra?.admission_requests?.length ? `Admission requests: ${extra.admission_requests.join(', ')}` : '',
      extra?.repo ? `GitNexus repo: ${extra.repo}` : '',
      extra?.worktree ? `Worktree path: ${extra.worktree}` : '',
      '',
      `_Bound to \`${evidence.head_sha}\`. A new commit invalidates this Verified stamp._`,
    ].filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n');
    const existingId = await this.findCommentId(number, `<!-- orch-proof:${task.id}:`);
    if (existingId !== undefined) {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await this.run('gh', [
            'api',
            '--method',
            'PATCH',
            `repos/{owner}/{repo}/issues/comments/${existingId}`,
            '-f',
            `body=${body}`,
          ], {
            timeout: 30_000,
            windowsHide: true,
          });
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (lastErr) {
        throw new GitHubProofError(
          'gh proof comment update failed',
          lastErr instanceof Error ? lastErr.message : String(lastErr),
        );
      }
      await publishProofCheck(this.run, evidence);
      return 'updated';
    }
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.run('gh', ['pr', 'comment', String(number), '--body', body], {
          timeout: 30_000,
          windowsHide: true,
        });
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) {
      throw new GitHubProofError(
        'gh pr comment failed',
        lastErr instanceof Error ? lastErr.message : String(lastErr),
      );
    }
    await publishProofCheck(this.run, evidence);
    return 'posted';
  }

  private async findCommentId(prNumber: number, marker: string): Promise<number | undefined> {
    try {
      const { stdout } = await this.run('gh', [
        'api',
        `repos/{owner}/{repo}/issues/${prNumber}/comments`,
      ], { timeout: 15_000, windowsHide: true });
      const parsed: unknown = JSON.parse(stdout);
      if (!Array.isArray(parsed)) return undefined;
      for (const item of parsed) {
        if (
          item
          && typeof item === 'object'
          && 'id' in item
          && 'body' in item
          && typeof item.id === 'number'
          && typeof item.body === 'string'
          && item.body.includes(marker)
        ) {
          return item.id;
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
}

/** Spec §8.3: comment is canonical; a HEAD-bound check is fail-open so a new commit cannot keep Verified. */
async function publishProofCheck(
  run: typeof execFileAsync,
  evidence: VerificationEvidence,
): Promise<void> {
  const sha = evidence.head_sha;
  if (!sha) return;
  try {
    await run('gh', [
      'api',
      '--method',
      'POST',
      'repos/{owner}/{repo}/check-runs',
      '-f',
      'name=ORCH verification proof',
      '-f',
      `head_sha=${sha}`,
      '-f',
      'status=completed',
      '-f',
      `conclusion=${evidence.verified ? 'success' : 'failure'}`,
      '-f',
      `output[title]=${evidence.verified ? 'Verified' : 'Not verified'}`,
      '-f',
      `output[summary]=ORCH proof bound to ${sha}. A new commit requires a new review.`,
    ], {
      timeout: 15_000,
      windowsHide: true,
    });
  } catch {
    // Fail-open: the PR comment is the canonical proof artifact.
  }
}
