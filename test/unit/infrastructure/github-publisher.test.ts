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

  it('retries a transient gh proof comment update then succeeds', async () => {
    let patches = 0;
    const run = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'git') return { stdout: 'abc123\n', stderr: '' };
      if (args.includes('--method') && args.includes('PATCH')) {
        patches += 1;
        if (patches === 1) throw new Error('gh api 502');
        return { stdout: '', stderr: '' };
      }
      return {
        stdout: JSON.stringify([
          { id: 42, body: `${proofCommentMarker('tsk_test1', 'abc123')}\nold proof` },
        ]),
        stderr: '',
      };
    });
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
    expect(patches).toBe(2);
  });

  it('updates the existing comment for the same SHA', async () => {
    const run = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'git') return { stdout: 'abc123\n', stderr: '' };
      if (args.includes('--method') && args.includes('PATCH')) {
        return { stdout: '', stderr: '' };
      }
      return {
        stdout: JSON.stringify([
          { id: 42, body: `${proofCommentMarker('tsk_test1', 'abc123')}\nold proof` },
        ]),
        stderr: '',
      };
    });
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
    const patchArgs = run.mock.calls.find((call) => (call[1] as string[]).includes('PATCH'))?.[1] as string[];
    expect(patchArgs).toContain('PATCH');
    expect(patchArgs.some((arg) => arg.includes('issues/comments/42'))).toBe(true);
    expect(run.mock.calls.some((call) => (call[1] as string[]).includes('comment'))).toBe(false);
    const checkArgs = run.mock.calls.find((call) => (call[1] as string[]).includes('repos/{owner}/{repo}/check-runs'))?.[1] as string[];
    expect(checkArgs).toContain('head_sha=abc123');
    expect(checkArgs).toContain('conclusion=success');
  });

  it('updates the existing task proof comment when HEAD SHA changes', async () => {
    const run = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'git') return { stdout: 'newsha\n', stderr: '' };
      if (args.includes('--method') && args.includes('PATCH')) {
        return { stdout: '', stderr: '' };
      }
      return {
        stdout: JSON.stringify([
          { id: 77, body: `${proofCommentMarker('tsk_test1', 'oldsha')}\nstale verified` },
        ]),
        stderr: '',
      };
    });
    const publisher = new GitHubProofPublisher(run as never);
    const action = await publisher.publish(
      makeTask({
        external: {
          github: { pr_number: 9, pr_url: 'https://example/pull/9' },
          linear: { id: 'x', identifier: 'ENG-123' },
        },
      }),
      {
        task_id: 'tsk_1',
        head_sha: 'newsha',
        files_changed: [],
        checks: [],
        reviews: [],
        acceptance_criteria: [],
        verified: false,
      },
    );
    expect(action).toBe('updated');
    const patchBody = (run.mock.calls.find((call) => (call[1] as string[]).includes('PATCH'))?.[1] as string[])
      .find((arg) => arg.startsWith('body='));
    expect(patchBody).toContain('<!-- orch-proof:tsk_test1:newsha -->');
    expect(patchBody).toContain('Linear: ENG-123');
    expect(run.mock.calls.some((call) => (call[1] as string[]).includes('comment'))).toBe(false);
    const checkArgs = run.mock.calls.find((call) => (call[1] as string[]).includes('head_sha=newsha'))?.[1] as string[];
    expect(checkArgs).toContain('conclusion=failure');
  });

  it('refuses Verified when HEAD still has changes_requested', async () => {
    const run = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'git') return { stdout: 'abc123\n', stderr: '' };
      if (args[0] === 'pr') return { stdout: '', stderr: '' };
      return { stdout: '[]', stderr: '' };
    });
    const publisher = new GitHubProofPublisher(run as never);
    const evidence = {
      task_id: 'tsk_1',
      head_sha: 'abc123',
      files_changed: [],
      checks: [],
      reviews: [
        {
          reviewer_type: 'human' as const,
          reviewer: 'alice',
          commit_sha: 'abc123',
          verdict: 'approve' as const,
          summary: 'ok',
          timestamp: 't',
        },
        {
          reviewer_type: 'cursor' as const,
          reviewer: 'cursor-cli',
          commit_sha: 'abc123',
          verdict: 'changes_requested' as const,
          summary: 'gaps',
          timestamp: 't',
        },
      ],
      acceptance_criteria: [],
      verified: true,
    };
    await publisher.publish(
      makeTask({ external: { github: { pr_number: 9, pr_url: 'https://example/pull/9' } } }),
      evidence,
    );
    expect(evidence.verified).toBe(false);
    const checkArgs = run.mock.calls.find((call) => (call[1] as string[]).includes('conclusion=failure'))?.[1] as string[];
    expect(checkArgs).toContain('conclusion=failure');
  });

  it('refuses Verified when branch HEAD moved past the proof SHA', async () => {
    const run = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'git') return { stdout: 'newsha\n', stderr: '' };
      if (args[0] === 'pr') return { stdout: '', stderr: '' };
      return { stdout: '[]', stderr: '' };
    });
    const publisher = new GitHubProofPublisher(run as never);
    const evidence = {
      task_id: 'tsk_1',
      head_sha: 'deadbeef',
      files_changed: [],
      checks: [],
      reviews: [],
      acceptance_criteria: [],
      verified: true,
    };
    await publisher.publish(
      makeTask({
        external: { github: { pr_number: 9, pr_url: 'https://example/pull/9' } },
        proof: { branch: 'orch/tsk_1', head_sha: 'deadbeef', files_changed: [], verified: true },
      }),
      evidence,
    );
    expect(evidence.verified).toBe(false);
    const checkArgs = run.mock.calls.find((call) =>
      (call[1] as string[]).some((arg) => arg.includes('check-runs')),
    )?.[1] as string[];
    expect(checkArgs).toContain('conclusion=failure');
  });

  it('posts a new comment when no current SHA marker exists', async () => {
    const run = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'git') return { stdout: 'abc123\n', stderr: '' };
      if (args[0] === 'pr') return { stdout: '', stderr: '' };
      return { stdout: '[]', stderr: '' };
    });
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
    expect(action).toBe('posted');
    expect(run.mock.calls.some((call) => (call[1] as string[]).includes('comment'))).toBe(true);
    expect(run.mock.calls.some((call) => (call[1] as string[]).includes('repos/{owner}/{repo}/check-runs'))).toBe(true);
  });

  it('appends deleted symbols from the admission audit onto the GitHub proof comment', async () => {
    const run = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'git') return { stdout: 'abc123\n', stderr: '' };
      if (args[0] === 'pr') return { stdout: '', stderr: '' };
      return { stdout: '[]', stderr: '' };
    });
    const publisher = new GitHubProofPublisher(run as never);
    await publisher.publish(
      makeTask({
        external: { github: { pr_number: 9, pr_url: 'https://example/pull/9' } },
        feedback: 'admission: deleted symbols: oldHelper',
      }),
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
    const commentArgs = run.mock.calls.find((call) => (call[1] as string[]).includes('comment'))?.[1] as string[];
    expect(commentArgs.some((arg) => arg.includes('Deleted symbols: oldHelper'))).toBe(true);
  });

  it('appends admission request ids onto the GitHub proof comment', async () => {
    const run = vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'git') return { stdout: 'abc123\n', stderr: '' };
      if (args[0] === 'pr') return { stdout: '', stderr: '' };
      return { stdout: '[]', stderr: '' };
    });
    const publisher = new GitHubProofPublisher(run as never);
    await publisher.publish(
      makeTask({ external: { github: { pr_number: 9, pr_url: 'https://example/pull/9' } } }),
      {
        task_id: 'tsk_1',
        head_sha: 'abc123',
        files_changed: [],
        checks: [],
        reviews: [],
        acceptance_criteria: [],
        verified: true,
        admission: {
          passed: true,
          incomplete: false,
          violations: [],
          admission_requests: ['adm_1', 'adm_2'],
          repo: 'ORCH',
          worktree: '/wt/task-a',
        } as never,
      },
    );
    const commentArgs = run.mock.calls.find((call) => (call[1] as string[]).includes('comment'))?.[1] as string[];
    expect(commentArgs.some((arg) => arg.includes('Admission requests: adm_1, adm_2'))).toBe(true);
    expect(commentArgs.some((arg) => arg.includes('GitNexus repo: ORCH'))).toBe(true);
    expect(commentArgs.some((arg) => arg.includes('Worktree path: /wt/task-a'))).toBe(true);
  });
});
