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

export function proofCommentMarker(headSha: string): string {
  return `<!-- orch-proof:${headSha} -->`;
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
    const marker = proofCommentMarker(evidence.head_sha);
    if (await this.hasMarker(number, marker)) {
      return 'updated';
    }
    const body = [
      marker,
      renderGitHubProof(evidence),
      '',
      `_Bound to \`${evidence.head_sha}\`. A new commit invalidates this Verified stamp._`,
    ].join('\n');
    try {
      await this.run('gh', ['pr', 'comment', String(number), '--body', body], {
        timeout: 30_000,
        windowsHide: true,
      });
    } catch (err) {
      throw new GitHubProofError(
        'gh pr comment failed',
        err instanceof Error ? err.message : String(err),
      );
    }
    return 'posted';
  }

  private async hasMarker(prNumber: number, marker: string): Promise<boolean> {
    try {
      const { stdout } = await this.run('gh', [
        'pr', 'view', String(prNumber), '--json', 'comments', '--jq', '[.comments[].body] | join("\\n")',
      ], { timeout: 15_000, windowsHide: true });
      return stdout.includes(marker);
    } catch {
      return false;
    }
  }
}
