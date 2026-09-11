import { describe, it, expect, vi } from 'vitest';
import { GitHubProofPublisher, proofCommentMarker } from '../../../src/infrastructure/proof/github-publisher.js';
import { makeTask } from '../application/helpers.js';

describe('GitHubProofPublisher', () => {
  it('refuses to publish without a SHA', async () => {
    const publisher = new GitHubProofPublisher(vi.fn() as never);
    await expect(publisher.publish(
      makeTask({ external: { github: { pr_number: 1, pr_url: 'https://example/pull/1' } } }),
      {
        task_id: 'tsk_1',
        files_changed: [],
        checks: [],
        reviews: [],
        acceptance_criteria: [],
        verified: false,
      },
    )).rejects.toThrow(/HEAD SHA/);
  });

  it('skips a second comment for the same SHA', async () => {
    const run = vi.fn(async () => ({
      stdout: `${proofCommentMarker('abc123')}\nold proof`,
      stderr: '',
    }));
    const publisher = new GitHubProofPublisher(run as never);
    const action = await publisher.publish(
      makeTask({ external: { github: { pr_number: 9, pr_url: 'https://example/pull/9' } } }),
      {
        task_id: 'tsk_1',
        head_sha: 'abc123',
        files_changed: [],
        checks: [],
        reviews: [],
        acceptance_criteria: [],
        verified: true,
      },
    );
    expect(action).toBe('updated');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
