import { afterEach, describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  LINEAR_STATE_FOR_TASK,
  LinearIssueTracker,
  clearStoredLinearApiKey,
  createLinearTracker,
  orchLinearLabelNames,
  readStoredLinearApiKey,
  resolveLinearApiKey,
  writeStoredLinearApiKey,
} from '../../../src/infrastructure/integrations/linear/linear-issue-tracker.js';
import type { Task } from '../../../src/domain/task.js';
import type { ReviewEvidence } from '../../../src/domain/evidence.js';

describe('Linear status mapping', () => {
  it('maps ORCH statuses onto Linear state names', () => {
    expect(LINEAR_STATE_FOR_TASK.todo).toContain('todo');
    expect(LINEAR_STATE_FOR_TASK.in_progress).toContain('in progress');
    expect(LINEAR_STATE_FOR_TASK.review).toContain('in review');
    expect(LINEAR_STATE_FOR_TASK.done).toContain('done');
    expect(LINEAR_STATE_FOR_TASK.done).toContain('merged');
    expect(LINEAR_STATE_FOR_TASK.failed).toContain('canceled');
  });

  it('always includes the orch label and keeps task labels', () => {
    expect(orchLinearLabelNames({ labels: ['high-risk', 'orch'] })).toEqual(['orch', 'high-risk', 'risk / high']);
    expect(orchLinearLabelNames({ labels: ['bug', 'feature'] })).toEqual(['orch', 'bug', 'feature', 'type / bug', 'type / feature']);
  });

  it('this repository requires a Linear issue before dispatch', () => {
    const raw = readFileSync(path.join(process.cwd(), '.orch', 'workflow.yml'), 'utf8');
    expect(raw).toMatch(/enabled:\s*true/);
    expect(raw).toMatch(/required_before_dispatch:\s*true/);
  });

  it('creates a missing orch label before issueCreate', async () => {
    const calls: string[] = [];
    let createdDescription = '';
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: string;
        variables?: { input?: { labelIds?: string[]; name?: string; description?: string } };
      };
      calls.push(body.query);
      if (body.query.includes('teams {')) {
        return Response.json({ data: { teams: { nodes: [{ id: 'team_1', key: 'KON' }] } } });
      }
      if (body.query.includes('labels { nodes')) {
        return Response.json({ data: { team: { labels: { nodes: [] } } } });
      }
      if (body.query.includes('issueLabelCreate')) {
        const name = body.variables?.input?.name ?? '';
        expect(['orch', 'ORCH State / Planned']).toContain(name);
        return Response.json({
          data: { issueLabelCreate: { success: true, issueLabel: { id: name === 'orch' ? 'lbl_orch' : 'lbl_planned' } } },
        });
      }
      if (body.query.includes('issueCreate')) {
        expect(body.variables?.input?.labelIds).toEqual(['lbl_orch', 'lbl_planned']);
        createdDescription = body.variables?.input?.description ?? '';
        return Response.json({
          data: { issueCreate: { success: true, issue: { id: 'iss_1', identifier: 'KON-1', url: 'https://linear.app/k/KON-1' } } },
        });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const task: Task = {
      id: 'tsk_1',
      title: 'Retry helper',
      description: 'Reuse existing backoff',
      status: 'todo',
      priority: 3,
      labels: [],
      depends_on: ['tsk_dep'],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
      goalId: 'goal_1',
      plan_id: 'plan_1',
      plan_unit_id: 'U-03',
      scope: ['src/sync/**'],
      acceptance_criteria: ['Retry uses existing helper'],
      review_criteria: ['test_pass'],
    };
    const ref = await new LinearIssueTracker('lin_test', 'KON', http).createForTask(task);
    expect(ref.identifier).toBe('KON-1');
    expect(calls.some((query) => query.includes('issueLabelCreate'))).toBe(true);
    expect(createdDescription).toContain('## ORCH Task');
    expect(createdDescription).toContain('`tsk_1`');
    expect(createdDescription).toContain('Goal: `goal_1`');
    expect(createdDescription).toContain('Plan unit: `U-03`');
    expect(createdDescription).toContain('### Acceptance criteria');
    expect(createdDescription).toContain('- [ ] Retry uses existing helper');
    expect(createdDescription).toContain('### Dependencies');
    expect(createdDescription).toContain('- tsk_dep');
  });

  it('includes the goal title on the Linear Goal line when the goal file exists', async () => {
    const previousApiKey = process.env['LINEAR_API_KEY'];
    process.env['LINEAR_API_KEY'] = 'lin_test';
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-linear-goal-'));
    mkdirSync(path.join(dir, 'goals'), { recursive: true });
    writeFileSync(path.join(dir, 'goals', 'goal_1.yml'), 'id: goal_1\ntitle: Compound Linear Council\n');
    let createdDescription = '';
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: string;
        variables?: { input?: { description?: string } };
      };
      if (body.query.includes('teams {')) {
        return Response.json({ data: { teams: { nodes: [{ id: 'team_1', key: 'KON' }] } } });
      }
      if (body.query.includes('labels { nodes')) {
        return Response.json({
          data: { team: { labels: { nodes: [{ id: 'lbl_orch', name: 'orch' }, { id: 'lbl_planned', name: 'ORCH State / Planned' }] } } },
        });
      }
      if (body.query.includes('issueCreate')) {
        createdDescription = body.variables?.input?.description ?? '';
        return Response.json({
          data: { issueCreate: { success: true, issue: { id: 'iss_1', identifier: 'KON-1', url: 'https://linear.app/k/KON-1' } } },
        });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const tracker = createLinearTracker(
      { linear: { enabled: true, team_key: 'KON' } },
      http,
      dir,
    );
    try {
      expect(tracker).not.toBeNull();
      await tracker!.createForTask({
        id: 'tsk_goal',
        title: 'Retry helper',
        description: 'd',
        status: 'todo',
        priority: 3,
        labels: [],
        depends_on: [],
        created_at: 't',
        updated_at: 't',
        attempts: 0,
        max_attempts: 3,
        goalId: 'goal_1',
      });
      expect(createdDescription).toContain('Goal: `goal_1 / Compound Linear Council`');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (previousApiKey === undefined) delete process.env['LINEAR_API_KEY'];
      else process.env['LINEAR_API_KEY'] = previousApiKey;
    }
  });

  it('persists Linear mappings under .orchestry/integrations/linear/', async () => {
    const previousApiKey = process.env['LINEAR_API_KEY'];
    process.env['LINEAR_API_KEY'] = 'lin_test';
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-linear-map-'));
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { query: string };
      if (body.query.includes('teams {')) {
        return Response.json({ data: { teams: { nodes: [{ id: 'team_1', key: 'KON' }] } } });
      }
      if (body.query.includes('labels { nodes')) {
        return Response.json({
          data: { team: { labels: { nodes: [{ id: 'lbl_orch', name: 'orch' }, { id: 'lbl_planned', name: 'ORCH State / Planned' }] } } },
        });
      }
      if (body.query.includes('issueCreate')) {
        return Response.json({
          data: { issueCreate: { success: true, issue: { id: 'iss_1', identifier: 'KON-1', url: 'https://linear.app/k/KON-1' } } },
        });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const tracker = createLinearTracker(
      { linear: { enabled: true, team_key: 'KON' } },
      http,
      dir,
    );
    const task: Task = {
      id: 'tsk_map',
      title: 'Retry helper',
      description: 'd',
      status: 'todo',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
    };
    try {
      expect(tracker).not.toBeNull();
      await tracker!.createForTask(task);
      const raw = readFileSync(path.join(dir, 'integrations', 'linear', 'mappings.json'), 'utf8');
      const mappings = JSON.parse(raw) as Record<string, { identifier?: string }>;
      expect(mappings.tsk_map?.identifier).toBe('KON-1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (previousApiKey === undefined) delete process.env['LINEAR_API_KEY'];
      else process.env['LINEAR_API_KEY'] = previousApiKey;
    }
  });

  it('reuses a local Linear mapping instead of creating a second issue', async () => {
    const previousApiKey = process.env['LINEAR_API_KEY'];
    process.env['LINEAR_API_KEY'] = 'lin_test';
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-linear-lookup-'));
    mkdirSync(path.join(dir, 'integrations', 'linear'), { recursive: true });
    writeFileSync(
      path.join(dir, 'integrations', 'linear', 'mappings.json'),
      JSON.stringify({
        tsk_lost: {
          id: 'iss_existing',
          identifier: 'KON-9',
          url: 'https://linear.app/k/KON-9',
          synced_at: 't',
        },
      }),
    );
    const queries: string[] = [];
    let updatedDescription = '';
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: string;
        variables?: { input?: { description?: string } };
      };
      queries.push(body.query);
      if (body.query.includes('issueUpdate')) {
        updatedDescription = body.variables?.input?.description ?? '';
        return Response.json({ data: { issueUpdate: { success: true } } });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const tracker = createLinearTracker(
      { linear: { enabled: true, team_key: 'KON' } },
      http,
      dir,
    );
    const task: Task = {
      id: 'tsk_lost',
      title: 'Retry helper',
      description: 'd',
      status: 'todo',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
    };
    try {
      const ref = await tracker!.createForTask(task);
      expect(ref.identifier).toBe('KON-9');
      expect(queries.some((query) => query.includes('issueCreate'))).toBe(false);
      expect(queries.some((query) => query.includes('issueUpdate'))).toBe(true);
      expect(updatedDescription).toContain('ORCH task: `tsk_lost`');
      expect(updatedDescription).toContain('### Description');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (previousApiKey === undefined) delete process.env['LINEAR_API_KEY'];
      else process.env['LINEAR_API_KEY'] = previousApiKey;
    }
  });

  it('looks up an existing Linear issue by ORCH task fingerprint before create', async () => {
    const previousApiKey = process.env['LINEAR_API_KEY'];
    process.env['LINEAR_API_KEY'] = 'lin_test';
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-linear-fp-'));
    const queries: string[] = [];
    let updatedDescription = '';
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: string;
        variables?: { input?: { description?: string } };
      };
      queries.push(body.query);
      if (body.query.includes('issues(filter')) {
        return Response.json({
          data: {
            issues: {
              nodes: [{
                id: 'iss_remote',
                identifier: 'KON-22',
                url: 'https://linear.app/k/KON-22',
                description: '## ORCH Task\n\nORCH task: `tsk_fp`\n',
              }],
            },
          },
        });
      }
      if (body.query.includes('issueUpdate')) {
        updatedDescription = body.variables?.input?.description ?? '';
        return Response.json({ data: { issueUpdate: { success: true } } });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const tracker = createLinearTracker(
      { linear: { enabled: true, team_key: 'KON' } },
      http,
      dir,
    );
    const task: Task = {
      id: 'tsk_fp',
      title: 'Retry helper',
      description: 'd',
      status: 'todo',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
    };
    try {
      const ref = await tracker!.createForTask(task);
      expect(ref.identifier).toBe('KON-22');
      expect(queries.some((query) => query.includes('issueCreate'))).toBe(false);
      expect(updatedDescription).toContain('ORCH task: `tsk_fp`');
      expect(updatedDescription).toContain('### Acceptance criteria');
      const raw = readFileSync(path.join(dir, 'integrations', 'linear', 'mappings.json'), 'utf8');
      const mappings = JSON.parse(raw) as Record<string, { identifier?: string }>;
      expect(mappings.tsk_fp?.identifier).toBe('KON-22');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (previousApiKey === undefined) delete process.env['LINEAR_API_KEY'];
      else process.env['LINEAR_API_KEY'] = previousApiKey;
    }
  });

  it('refreshes Goal title and acceptance on a recovered Linear issue', async () => {
    const previousApiKey = process.env['LINEAR_API_KEY'];
    process.env['LINEAR_API_KEY'] = 'lin_test';
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-linear-refresh-'));
    mkdirSync(path.join(dir, 'goals'), { recursive: true });
    mkdirSync(path.join(dir, 'integrations', 'linear'), { recursive: true });
    writeFileSync(path.join(dir, 'goals', 'goal_1.yml'), 'id: goal_1\ntitle: Renamed Council Goal\n');
    writeFileSync(
      path.join(dir, 'integrations', 'linear', 'mappings.json'),
      JSON.stringify({
        tsk_refresh: {
          id: 'iss_old',
          identifier: 'KON-8',
          url: 'https://linear.app/k/KON-8',
          synced_at: 't',
        },
      }),
    );
    let updated = '';
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: string;
        variables?: { input?: { title?: string; description?: string } };
      };
      if (body.query.includes('issueUpdate')) {
        updated = `${body.variables?.input?.title ?? ''}\n${body.variables?.input?.description ?? ''}`;
        return Response.json({ data: { issueUpdate: { success: true } } });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const tracker = createLinearTracker(
      { linear: { enabled: true, team_key: 'KON' } },
      http,
      dir,
    );
    try {
      const ref = await tracker!.createForTask({
        id: 'tsk_refresh',
        title: 'Updated retry helper',
        description: 'Reuse existing backoff',
        status: 'todo',
        priority: 3,
        labels: [],
        depends_on: [],
        created_at: 't',
        updated_at: 't',
        attempts: 0,
        max_attempts: 3,
        goalId: 'goal_1',
        acceptance_criteria: ['Retry uses existing helper'],
      });
      expect(ref.identifier).toBe('KON-8');
      expect(updated).toContain('Updated retry helper');
      expect(updated).toContain('Goal: `goal_1 / Renamed Council Goal`');
      expect(updated).toContain('- [ ] Retry uses existing helper');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (previousApiKey === undefined) delete process.env['LINEAR_API_KEY'];
      else process.env['LINEAR_API_KEY'] = previousApiKey;
    }
  });

  it('creates blockedBy Linear relations for dependency issues', async () => {
    const inputs: Array<{ issueId?: string; relatedIssueId?: string; type?: string }> = [];
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: string;
        variables?: { input?: { issueId?: string; relatedIssueId?: string; type?: string } };
      };
      if (body.query.includes('issueRelationCreate')) {
        inputs.push(body.variables?.input ?? {});
        return Response.json({ data: { issueRelationCreate: { success: true } } });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    await new LinearIssueTracker('lin_test', 'KON', http).linkBlockedBy('iss_a', ['iss_b', 'iss_a', 'iss_b']);
    expect(inputs).toEqual([{ issueId: 'iss_a', relatedIssueId: 'iss_b', type: 'blockedBy' }]);
  });

  it('rewrites the Dependencies section with Linear identifiers', async () => {
    let updated = '';
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: string;
        variables?: { input?: { description?: string } };
      };
      if (body.query.includes('issue(id:') || body.query.includes('issue(id: $id)')) {
        return Response.json({
          data: { issue: { description: '## ORCH Task\n\n### Dependencies\n- tsk_dep\n\nDo not create a second issue.\n' } },
        });
      }
      if (body.query.includes('issueUpdate')) {
        updated = body.variables?.input?.description ?? '';
        return Response.json({ data: { issueUpdate: { success: true } } });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    await new LinearIssueTracker('lin_test', 'KON', http).refreshDependencyDescription('iss_a', ['- tsk_dep (ENG-1)']);
    expect(updated).toContain('- tsk_dep (ENG-1)');
    expect(updated).toContain('Do not create a second issue.');
  });

  it('posts a structured Linear comment when a PR is linked', async () => {
    let commentBody = '';
    const queries: string[] = [];
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: string;
        variables?: { input?: { body?: string } };
      };
      queries.push(body.query);
      if (body.query.includes('commentCreate')) {
        commentBody = body.variables?.input?.body ?? '';
        return Response.json({ data: { commentCreate: { success: true } } });
      }
      if (body.query.includes('attachmentLinkGitHubPR')) {
        return Response.json({ data: { attachmentLinkGitHubPR: { success: true } } });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const task: Task = {
      id: 'tsk_1',
      title: 'Retry helper',
      description: 'd',
      status: 'todo',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
      external: { linear: { id: 'iss_1', identifier: 'KON-1' } },
    };
    await new LinearIssueTracker('lin_test', 'KON', http).onPullRequestLinked(task, {
      provider: 'github',
      number: 12,
      url: 'https://github.com/codykociemba/ORCH/pull/12',
      branch: 'orch/KON-1-retry',
      head_sha: 'abcdef123456',
    });
    expect(commentBody).toContain('### Pull request opened');
    expect(commentBody).toContain('<!-- orch-pr:tsk_1:12 -->');
    expect(commentBody).toContain('https://github.com/codykociemba/ORCH/pull/12');
    expect(commentBody).toContain('orch/KON-1-retry');
    expect(commentBody).toContain('abcdef1');
    expect(queries.some((query) => query.includes('attachmentLinkGitHubPR'))).toBe(true);
  });

  it('updates the existing Linear PR comment instead of posting a second one', async () => {
    let created = 0;
    let updated = '';
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: string;
        variables?: { input?: { body?: string }; body?: string };
      };
      if (body.query.includes('comments { nodes')) {
        return Response.json({
          data: {
            issue: {
              comments: {
                nodes: [{ id: 'cmt_pr', body: '<!-- orch-pr:tsk_1:12 -->\n### Pull request opened\n\nPR: https://github.com/codykociemba/ORCH/pull/12\nHead: `oldsha0`' }],
              },
            },
          },
        });
      }
      if (body.query.includes('commentCreate')) {
        created += 1;
        return Response.json({ data: { commentCreate: { success: true } } });
      }
      if (body.query.includes('commentUpdate')) {
        updated = body.variables?.body ?? body.variables?.input?.body ?? '';
        return Response.json({ data: { commentUpdate: { success: true } } });
      }
      if (body.query.includes('attachmentLinkGitHubPR')) {
        return Response.json({ data: { attachmentLinkGitHubPR: { success: true } } });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const task: Task = {
      id: 'tsk_1',
      title: 'Retry helper',
      description: 'd',
      status: 'review',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
      external: { linear: { id: 'iss_1', identifier: 'KON-1' } },
    };
    await new LinearIssueTracker('lin_test', 'KON', http).onPullRequestLinked(task, {
      provider: 'github',
      number: 12,
      url: 'https://github.com/codykociemba/ORCH/pull/12',
      branch: 'orch/KON-1-retry',
      head_sha: 'abcdef123456',
    });
    expect(created).toBe(0);
    expect(updated).toContain('<!-- orch-pr:tsk_1:12 -->');
    expect(updated).toContain('https://github.com/codykociemba/ORCH/pull/12');
  });

  it('does not rewrite the Linear PR comment when the same URL and SHA are already linked', async () => {
    let created = 0;
    let updated = 0;
    const existingBody = [
      '<!-- orch-pr:tsk_1:12 -->',
      '### Pull request opened',
      '',
      'PR: https://github.com/codykociemba/ORCH/pull/12',
      'Branch: `orch/KON-1-retry`',
      'Head: `abcdef1`',
    ].join('\n');
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { query: string };
      if (body.query.includes('comments { nodes')) {
        return Response.json({
          data: {
            issue: {
              comments: {
                nodes: [{ id: 'cmt_pr', body: existingBody }],
              },
            },
          },
        });
      }
      if (body.query.includes('commentCreate')) {
        created += 1;
        return Response.json({ data: { commentCreate: { success: true } } });
      }
      if (body.query.includes('commentUpdate')) {
        updated += 1;
        return Response.json({ data: { commentUpdate: { success: true } } });
      }
      if (body.query.includes('attachmentLinkGitHubPR')) {
        return Response.json({ data: { attachmentLinkGitHubPR: { success: true } } });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const task: Task = {
      id: 'tsk_1',
      title: 'Retry helper',
      description: 'd',
      status: 'review',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
      external: { linear: { id: 'iss_1', identifier: 'KON-1' } },
    };
    await new LinearIssueTracker('lin_test', 'KON', http).onPullRequestLinked(task, {
      provider: 'github',
      number: 12,
      url: 'https://github.com/codykociemba/ORCH/pull/12',
      branch: 'orch/KON-1-retry',
      head_sha: 'abcdef123456',
    });
    expect(created).toBe(0);
    expect(updated).toBe(0);
  });

  it('posts a second Linear PR comment when the same task opens another PR', async () => {
    let created = 0;
    const bodies: string[] = [];
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: string;
        variables?: { input?: { body?: string } };
      };
      if (body.query.includes('comments { nodes')) {
        return Response.json({
          data: {
            issue: {
              comments: {
                nodes: [{
                  id: 'cmt_pr12',
                  body: '<!-- orch-pr:tsk_1:12 -->\n### Pull request opened\n\nPR: https://github.com/codykociemba/ORCH/pull/12',
                }],
              },
            },
          },
        });
      }
      if (body.query.includes('commentCreate')) {
        created += 1;
        bodies.push(body.variables?.input?.body ?? '');
        return Response.json({ data: { commentCreate: { success: true } } });
      }
      if (body.query.includes('attachmentLinkGitHubPR')) {
        return Response.json({ data: { attachmentLinkGitHubPR: { success: true } } });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const task: Task = {
      id: 'tsk_1',
      title: 'Retry helper',
      description: 'd',
      status: 'review',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
      external: { linear: { id: 'iss_1', identifier: 'KON-1' } },
    };
    await new LinearIssueTracker('lin_test', 'KON', http).onPullRequestLinked(task, {
      provider: 'github',
      number: 18,
      url: 'https://github.com/codykociemba/ORCH/pull/18',
      branch: 'orch/KON-1-retry-b',
      head_sha: 'fff111222333',
    });
    expect(created).toBe(1);
    expect(bodies[0]).toContain('<!-- orch-pr:tsk_1:18 -->');
    expect(bodies[0]).toContain('https://github.com/codykociemba/ORCH/pull/18');
    expect(bodies[0]).not.toContain('<!-- orch-pr:tsk_1:12 -->');
  });

  it('comments a concise dispatch note when a task is assigned', async () => {
    let commentBody = '';
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: string;
        variables?: { input?: { body?: string } };
      };
      if (body.query.includes('commentCreate')) {
        commentBody = body.variables?.input?.body ?? '';
        return Response.json({ data: { commentCreate: { success: true } } });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const task: Task = {
      id: 'tsk_1',
      title: 'Retry helper',
      description: 'd',
      status: 'in_progress',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
      workspace: '/tmp/wt',
      proof: { branch: 'orch/KON-1-retry', files_changed: [] },
      external: { linear: { id: 'iss_1', identifier: 'KON-1' } },
    };
    await new LinearIssueTracker('lin_test', 'KON', http).onTaskAssigned(task, {
      id: 'agt_1',
      name: 'builder',
      adapter: 'claude',
      role: 'implement',
      status: 'running',
      config: { approval_policy: 'auto', max_turns: 10 },
      stats: { tasks_completed: 0, tasks_failed: 0, total_runs: 0, total_runtime_ms: 0 },
    });
    expect(commentBody).toContain('### Task dispatched');
    expect(commentBody).toContain('<!-- orch-dispatch:tsk_1 -->');
    expect(commentBody).toContain('tsk_1');
    expect(commentBody).toContain('builder');
    expect(commentBody).toContain('/tmp/wt');
    expect(commentBody).toContain('orch/KON-1-retry');
  });

  it('updates the existing Linear dispatch comment instead of posting a second one', async () => {
    let created = 0;
    let updated = '';
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: string;
        variables?: { input?: { body?: string }; body?: string };
      };
      if (body.query.includes('comments { nodes')) {
        return Response.json({
          data: {
            issue: {
              comments: {
                nodes: [{ id: 'cmt_dispatch', body: '<!-- orch-dispatch:tsk_1 -->\n### Task dispatched\n\nAgent: old' }],
              },
            },
          },
        });
      }
      if (body.query.includes('commentCreate')) {
        created += 1;
        return Response.json({ data: { commentCreate: { success: true } } });
      }
      if (body.query.includes('commentUpdate')) {
        updated = body.variables?.body ?? body.variables?.input?.body ?? '';
        return Response.json({ data: { commentUpdate: { success: true } } });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const task: Task = {
      id: 'tsk_1',
      title: 'Retry helper',
      description: 'd',
      status: 'in_progress',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
      workspace: '/tmp/wt',
      proof: { branch: 'orch/KON-1-retry', files_changed: [] },
      external: { linear: { id: 'iss_1', identifier: 'KON-1' } },
    };
    await new LinearIssueTracker('lin_test', 'KON', http).onTaskAssigned(task, {
      id: 'agt_1',
      name: 'builder',
      adapter: 'claude',
      role: 'implement',
      status: 'running',
      config: { approval_policy: 'auto', max_turns: 10 },
      stats: { tasks_completed: 0, tasks_failed: 0, total_runs: 0, total_runtime_ms: 0 },
    });
    expect(created).toBe(0);
    expect(updated).toContain('<!-- orch-dispatch:tsk_1 -->');
    expect(updated).toContain('builder');
    expect(updated).toContain('/tmp/wt');
  });

  it('returns Linear to In Progress when review requests changes', async () => {
    let commentBody = '';
    let stateId = '';
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: string;
        variables?: { input?: { body?: string }; stateId?: string };
      };
      if (body.query.includes('commentCreate')) {
        commentBody = body.variables?.input?.body ?? '';
        return Response.json({ data: { commentCreate: { success: true } } });
      }
      if (body.query.includes('teams {')) {
        return Response.json({ data: { teams: { nodes: [{ id: 'team_1', key: 'KON' }] } } });
      }
      if (body.query.includes('states { nodes')) {
        return Response.json({
          data: { team: { states: { nodes: [{ id: 'st_progress', name: 'In Progress', type: 'started' }] } } },
        });
      }
      if (body.query.includes('issueUpdate') && body.variables?.stateId) {
        stateId = body.variables.stateId;
        return Response.json({ data: { issueUpdate: { success: true } } });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const task: Task = {
      id: 'tsk_1',
      title: 'Retry helper',
      description: 'd',
      status: 'review',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
      external: { linear: { id: 'iss_1', identifier: 'KON-1' } },
    };
    await new LinearIssueTracker('lin_test', 'KON', http).onReview(task, {
      reviewer_type: 'cursor',
      reviewer: 'cursor-cli',
      commit_sha: 'abcdef1',
      verdict: 'changes_requested',
      summary: 'Need tests',
      timestamp: 't',
      blocking_findings: ['missing retry test'],
      plan_deviations: ['skipped U-04'],
    } as ReviewEvidence);
    expect(commentBody).toContain('changes_requested');
    expect(commentBody).toContain('blocking: missing retry test');
    expect(commentBody).toContain('plan: skipped U-04');
    expect(stateId).toBe('st_progress');
  });

  it('fail-closes a Linear review with no commit SHA', async () => {
    let commentBody = '';
    let stateId = '';
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: string;
        variables?: { input?: { body?: string }; stateId?: string };
      };
      if (body.query.includes('commentCreate')) {
        commentBody = body.variables?.input?.body ?? '';
        return Response.json({ data: { commentCreate: { success: true } } });
      }
      if (body.query.includes('teams {')) {
        return Response.json({ data: { teams: { nodes: [{ id: 'team_1', key: 'KON' }] } } });
      }
      if (body.query.includes('states { nodes')) {
        return Response.json({
          data: { team: { states: { nodes: [{ id: 'st_progress', name: 'In Progress', type: 'started' }] } } },
        });
      }
      if (body.query.includes('issueUpdate') && body.variables?.stateId) {
        stateId = body.variables.stateId;
        return Response.json({ data: { issueUpdate: { success: true } } });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const task: Task = {
      id: 'tsk_1',
      title: 'Retry helper',
      description: 'd',
      status: 'review',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
      external: { linear: { id: 'iss_1', identifier: 'KON-1' } },
    };
    await new LinearIssueTracker('lin_test', 'KON', http).onReview(task, {
      reviewer_type: 'cursor',
      reviewer: 'cursor-cli',
      commit_sha: '',
      verdict: 'approve',
      summary: 'ok',
      timestamp: 't',
    });
    expect(commentBody).toContain('failed');
    expect(commentBody).toContain('missing');
    expect(commentBody).toContain('fail closed');
    expect(stateId).toBe('st_progress');
  });

  it('surfaces the review verdict on the Linear GitHub attachment', async () => {
    let attachmentTitle = '';
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: string;
        variables?: { input?: { body?: string; title?: string }; title?: string };
      };
      if (body.query.includes('commentCreate')) {
        return Response.json({ data: { commentCreate: { success: true } } });
      }
      if (body.query.includes('attachments { nodes')) {
        return Response.json({
          data: {
            issue: {
              attachments: {
                nodes: [{ id: 'att_1', url: 'https://github.com/codykociemba/ORCH/pull/12' }],
              },
            },
          },
        });
      }
      if (body.query.includes('attachmentUpdate')) {
        attachmentTitle = body.variables?.title ?? body.variables?.input?.title ?? '';
        return Response.json({ data: { attachmentUpdate: { success: true } } });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const task: Task = {
      id: 'tsk_1',
      title: 'Retry helper',
      description: 'd',
      status: 'review',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
      external: {
        linear: { id: 'iss_1', identifier: 'KON-1' },
        github: { pr_url: 'https://github.com/codykociemba/ORCH/pull/12', pr_number: 12 },
      },
    };
    await new LinearIssueTracker('lin_test', 'KON', http).onReview(task, {
      reviewer_type: 'cursor',
      reviewer: 'cursor-cli',
      commit_sha: 'abcdef1',
      verdict: 'approve',
      summary: 'ok',
      timestamp: 't',
    });
    expect(attachmentTitle).toContain('approve');
    expect(attachmentTitle).toContain('abcdef1');
  });

  it('updates the existing Linear review comment for the same SHA', async () => {
    let created = 0;
    let updated = '';
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: string;
        variables?: { input?: { body?: string }; body?: string };
      };
      if (body.query.includes('comments { nodes')) {
        return Response.json({
          data: {
            issue: {
              comments: {
                nodes: [{ id: 'cmt_review', body: '<!-- orch-review:tsk_1:abcdef1 -->\n### Review\n\nVerdict: approve' }],
              },
            },
          },
        });
      }
      if (body.query.includes('commentCreate')) {
        created += 1;
        return Response.json({ data: { commentCreate: { success: true } } });
      }
      if (body.query.includes('commentUpdate')) {
        updated = body.variables?.body ?? body.variables?.input?.body ?? '';
        return Response.json({ data: { commentUpdate: { success: true } } });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const task: Task = {
      id: 'tsk_1',
      title: 'Retry helper',
      description: 'd',
      status: 'review',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
      external: { linear: { id: 'iss_1', identifier: 'KON-1' } },
    };
    await new LinearIssueTracker('lin_test', 'KON', http).onReview(task, {
      reviewer_type: 'cursor',
      reviewer: 'cursor-cli',
      commit_sha: 'abcdef1',
      verdict: 'approve',
      summary: 'ok after retry',
      timestamp: 't',
    });
    expect(created).toBe(0);
    expect(updated).toContain('<!-- orch-review:tsk_1:abcdef1 -->');
    expect(updated).toContain('ok after retry');
  });

  it('moves Linear to Done when a task is merged', async () => {
    let commentBody = '';
    let stateId = '';
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: string;
        variables?: { input?: { body?: string }; stateId?: string };
      };
      if (body.query.includes('commentCreate')) {
        commentBody = body.variables?.input?.body ?? '';
        return Response.json({ data: { commentCreate: { success: true } } });
      }
      if (body.query.includes('teams {')) {
        return Response.json({ data: { teams: { nodes: [{ id: 'team_1', key: 'KON' }] } } });
      }
      if (body.query.includes('states { nodes')) {
        return Response.json({
          data: { team: { states: { nodes: [{ id: 'st_done', name: 'Merged', type: 'completed' }] } } },
        });
      }
      if (body.query.includes('issueUpdate') && body.variables?.stateId) {
        stateId = body.variables.stateId;
        return Response.json({ data: { issueUpdate: { success: true } } });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const task: Task = {
      id: 'tsk_1',
      title: 'Retry helper',
      description: 'd',
      status: 'done',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
      external: { linear: { id: 'iss_1', identifier: 'KON-1' } },
    };
    await new LinearIssueTracker('lin_test', 'KON', http).onMerged(task, {
      sha: 'abcdef123456',
      merged_at: 't',
    });
    expect(commentBody).toContain('### Merged');
    expect(commentBody).toContain('<!-- orch-merge:tsk_1 -->');
    expect(commentBody).toContain('abcdef1');
    expect(stateId).toBe('st_done');
  });

  it('updates the existing Linear merge comment instead of posting a second one', async () => {
    let created = 0;
    let updated = '';
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: string;
        variables?: { input?: { body?: string }; body?: string };
      };
      if (body.query.includes('comments { nodes')) {
        return Response.json({
          data: {
            issue: {
              comments: {
                nodes: [{ id: 'cmt_merge', body: '<!-- orch-merge:tsk_1 -->\n### Merged\n\nHead: `oldsha1`' }],
              },
            },
          },
        });
      }
      if (body.query.includes('commentCreate')) {
        created += 1;
        return Response.json({ data: { commentCreate: { success: true } } });
      }
      if (body.query.includes('commentUpdate')) {
        updated = body.variables?.body ?? body.variables?.input?.body ?? '';
        return Response.json({ data: { commentUpdate: { success: true } } });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const task: Task = {
      id: 'tsk_1',
      title: 'Retry helper',
      description: 'd',
      status: 'done',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
      external: { linear: { id: 'iss_1', identifier: 'KON-1' } },
    };
    await new LinearIssueTracker('lin_test', 'KON', http).onMerged(task, {
      sha: 'abcdef123456',
      merged_at: 't',
    });
    expect(created).toBe(0);
    expect(updated).toContain('<!-- orch-merge:tsk_1 -->');
    expect(updated).toContain('abcdef1');
  });

  it('surfaces merged on the Linear GitHub attachment', async () => {
    let attachmentTitle = '';
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: string;
        variables?: { input?: { body?: string; title?: string }; title?: string; stateId?: string };
      };
      if (body.query.includes('commentCreate')) {
        return Response.json({ data: { commentCreate: { success: true } } });
      }
      if (body.query.includes('teams {')) {
        return Response.json({ data: { teams: { nodes: [{ id: 'team_1', key: 'KON' }] } } });
      }
      if (body.query.includes('states { nodes')) {
        return Response.json({
          data: { team: { states: { nodes: [{ id: 'st_done', name: 'Merged', type: 'completed' }] } } },
        });
      }
      if (body.query.includes('issueUpdate') && body.variables?.stateId) {
        return Response.json({ data: { issueUpdate: { success: true } } });
      }
      if (body.query.includes('attachments { nodes')) {
        return Response.json({
          data: {
            issue: {
              attachments: {
                nodes: [{ id: 'att_1', url: 'https://github.com/codykociemba/ORCH/pull/12' }],
              },
            },
          },
        });
      }
      if (body.query.includes('attachmentUpdate')) {
        attachmentTitle = body.variables?.title ?? body.variables?.input?.title ?? '';
        return Response.json({ data: { attachmentUpdate: { success: true } } });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const task: Task = {
      id: 'tsk_1',
      title: 'Retry helper',
      description: 'd',
      status: 'done',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
      external: {
        linear: { id: 'iss_1', identifier: 'KON-1' },
        github: { pr_url: 'https://github.com/codykociemba/ORCH/pull/12', pr_number: 12 },
      },
    };
    await new LinearIssueTracker('lin_test', 'KON', http).onMerged(task, {
      sha: 'abcdef123456',
      merged_at: 't',
      url: 'https://github.com/codykociemba/ORCH/pull/12',
    });
    expect(attachmentTitle).toContain('merged');
    expect(attachmentTitle).toContain('abcdef1');
  });

  it('adds the verified label when proof is verified for this SHA', async () => {
    let labelIds: string[] = [];
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: string;
        variables?: { labelIds?: string[]; input?: { labelIds?: string[] } };
      };
      if (body.query.includes('commentCreate')) {
        return Response.json({ data: { commentCreate: { success: true } } });
      }
      if (body.query.includes('teams {')) {
        return Response.json({ data: { teams: { nodes: [{ id: 'team_1', key: 'KON' }] } } });
      }
      if (body.query.includes('issue(id') && body.query.includes('labels { nodes')) {
        return Response.json({ data: { issue: { labels: { nodes: [{ id: 'lbl_orch', name: 'orch' }] } } } });
      }
      if (body.query.includes('labels { nodes')) {
        return Response.json({
          data: { team: { labels: { nodes: [{ id: 'lbl_verified', name: 'verified' }] } } },
        });
      }
      if (body.query.includes('issueUpdate') && body.variables?.labelIds) {
        labelIds = body.variables.labelIds;
        return Response.json({ data: { issueUpdate: { success: true } } });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const task: Task = {
      id: 'tsk_1',
      title: 'Retry helper',
      description: 'd',
      status: 'review',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
      external: { linear: { id: 'iss_1', identifier: 'KON-1' } },
    };
    await new LinearIssueTracker('lin_test', 'KON', http).publishEvidence(task, {
      task_id: 'tsk_1',
      files_changed: [],
      checks: [],
      reviews: [],
      acceptance_criteria: [],
      verified: true,
      head_sha: 'abcdef1',
    });
    expect(labelIds).toContain('lbl_verified');
    expect(labelIds).toContain('lbl_orch');
  });

  it('refuses the verified label when HEAD still has changes_requested', async () => {
    let labelIds: string[] = [];
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: string;
        variables?: { labelIds?: string[]; input?: { labelIds?: string[] } };
      };
      if (body.query.includes('commentCreate')) {
        return Response.json({ data: { commentCreate: { success: true } } });
      }
      if (body.query.includes('teams {')) {
        return Response.json({ data: { teams: { nodes: [{ id: 'team_1', key: 'KON' }] } } });
      }
      if (body.query.includes('issue(id') && body.query.includes('labels { nodes')) {
        return Response.json({
          data: { issue: { labels: { nodes: [{ id: 'lbl_verified', name: 'verified' }, { id: 'lbl_orch', name: 'orch' }] } } },
        });
      }
      if (body.query.includes('labels { nodes')) {
        return Response.json({
          data: { team: { labels: { nodes: [{ id: 'lbl_verified', name: 'verified' }] } } },
        });
      }
      if (body.query.includes('issueUpdate') && body.variables?.labelIds) {
        labelIds = body.variables.labelIds;
        return Response.json({ data: { issueUpdate: { success: true } } });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const task: Task = {
      id: 'tsk_1',
      title: 'Retry helper',
      description: 'd',
      status: 'review',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
      external: { linear: { id: 'iss_1', identifier: 'KON-1' } },
    };
    await new LinearIssueTracker('lin_test', 'KON', http).publishEvidence(task, {
      task_id: 'tsk_1',
      files_changed: [],
      checks: [],
      reviews: [
        {
          reviewer_type: 'human',
          reviewer: 'alice',
          commit_sha: 'abcdef1',
          verdict: 'approve',
          summary: 'ok',
          timestamp: 't',
        },
        {
          reviewer_type: 'cursor',
          reviewer: 'cursor-cli',
          commit_sha: 'abcdef1',
          verdict: 'changes_requested',
          summary: 'gaps',
          timestamp: 't',
        },
      ],
      acceptance_criteria: [],
      verified: true,
      head_sha: 'abcdef1',
    });
    expect(labelIds).not.toContain('lbl_verified');
  });

  it('drops verified and returns In Review when proof is not verified', async () => {
    let labelIds: string[] = [];
    let stateId = '';
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: string;
        variables?: { labelIds?: string[]; stateId?: string };
      };
      if (body.query.includes('commentCreate')) {
        return Response.json({ data: { commentCreate: { success: true } } });
      }
      if (body.query.includes('teams {')) {
        return Response.json({ data: { teams: { nodes: [{ id: 'team_1', key: 'KON' }] } } });
      }
      if (body.query.includes('issue(id') && body.query.includes('labels { nodes')) {
        return Response.json({
          data: { issue: { labels: { nodes: [{ id: 'lbl_verified', name: 'verified' }] } } },
        });
      }
      if (body.query.includes('states { nodes')) {
        return Response.json({
          data: { team: { states: { nodes: [{ id: 'st_review', name: 'In Review', type: 'started' }] } } },
        });
      }
      if (body.query.includes('labels { nodes')) {
        return Response.json({
          data: { team: { labels: { nodes: [{ id: 'lbl_verified', name: 'verified' }] } } },
        });
      }
      if (body.query.includes('issueUpdate') && body.variables?.labelIds) {
        labelIds = body.variables.labelIds;
        return Response.json({ data: { issueUpdate: { success: true } } });
      }
      if (body.query.includes('issueUpdate') && body.variables?.stateId) {
        stateId = body.variables.stateId;
        return Response.json({ data: { issueUpdate: { success: true } } });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const task: Task = {
      id: 'tsk_1',
      title: 'Retry helper',
      description: 'd',
      status: 'review',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
      external: { linear: { id: 'iss_1', identifier: 'KON-1' } },
    };
    await new LinearIssueTracker('lin_test', 'KON', http).publishEvidence(task, {
      task_id: 'tsk_1',
      files_changed: [],
      checks: [],
      reviews: [],
      acceptance_criteria: [],
      verified: false,
      head_sha: 'ffffff1',
    });
    expect(labelIds).not.toContain('lbl_verified');
    expect(stateId).toBe('st_review');
  });

  it('updates an existing Linear proof comment instead of posting a duplicate', async () => {
    let updatedBody = '';
    let created = 0;
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: string;
        variables?: { body?: string; input?: { body?: string } };
      };
      if (body.query.includes('issue(id') && body.query.includes('comments { nodes')) {
        return Response.json({
          data: {
            issue: {
              comments: {
                nodes: [{ id: 'cmt_1', body: '<!-- orch-proof:tsk_1:oldsha -->\n## ORCH verification proof' }],
              },
            },
          },
        });
      }
      if (body.query.includes('commentUpdate')) {
        updatedBody = body.variables?.body ?? '';
        return Response.json({ data: { commentUpdate: { success: true } } });
      }
      if (body.query.includes('commentCreate')) {
        created += 1;
        return Response.json({ data: { commentCreate: { success: true } } });
      }
      if (body.query.includes('teams {')) {
        return Response.json({ data: { teams: { nodes: [{ id: 'team_1', key: 'KON' }] } } });
      }
      if (body.query.includes('issue(id') && body.query.includes('labels { nodes')) {
        return Response.json({ data: { issue: { labels: { nodes: [{ id: 'lbl_orch', name: 'orch' }] } } } });
      }
      if (body.query.includes('labels { nodes')) {
        return Response.json({
          data: {
            team: {
              labels: {
                nodes: [
                  { id: 'lbl_verified', name: 'verified' },
                  { id: 'lbl_verified_state', name: 'ORCH State / Verified' },
                ],
              },
            },
          },
        });
      }
      if (body.query.includes('issueUpdate')) {
        return Response.json({ data: { issueUpdate: { success: true } } });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const task: Task = {
      id: 'tsk_1',
      title: 'Retry helper',
      description: 'd',
      status: 'review',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
      external: { linear: { id: 'iss_1', identifier: 'KON-1' } },
    };
    await new LinearIssueTracker('lin_test', 'KON', http).publishEvidence(task, {
      task_id: 'tsk_1',
      files_changed: [],
      checks: [],
      reviews: [],
      acceptance_criteria: [],
      verified: true,
      head_sha: 'newsha1',
    });
    expect(created).toBe(0);
    expect(updatedBody).toContain('<!-- orch-proof:tsk_1:newsha1 -->');
    expect(updatedBody).toContain('Verified: yes');
  });

  it('refuses to publish Linear proof without a HEAD SHA', async () => {
    let created = 0;
    const http = (async () => {
      created += 1;
      return Response.json({ data: {} });
    }) as typeof fetch;
    const task: Task = {
      id: 'tsk_1',
      title: 'Retry helper',
      description: 'd',
      status: 'review',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
      external: { linear: { id: 'iss_1', identifier: 'KON-1' } },
    };
    await expect(new LinearIssueTracker('lin_test', 'KON', http).publishEvidence(task, {
      task_id: 'tsk_1',
      files_changed: [],
      checks: [],
      reviews: [],
      acceptance_criteria: [],
      verified: true,
    })).rejects.toThrow(/HEAD SHA/);
    expect(created).toBe(0);
  });

  it('appends deleted symbols from the admission audit onto the Linear proof comment', async () => {
    let posted = '';
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: string;
        variables?: { input?: { body?: string } };
      };
      if (body.query.includes('commentCreate')) {
        posted = body.variables?.input?.body ?? '';
        return Response.json({ data: { commentCreate: { success: true } } });
      }
      if (body.query.includes('teams {')) {
        return Response.json({ data: { teams: { nodes: [{ id: 'team_1', key: 'KON' }] } } });
      }
      if (body.query.includes('issue(id') && body.query.includes('comments')) {
        return Response.json({ data: { issue: { comments: { nodes: [] } } } });
      }
      if (body.query.includes('issue(id') && body.query.includes('labels { nodes')) {
        return Response.json({ data: { issue: { labels: { nodes: [] } } } });
      }
      if (body.query.includes('labels { nodes')) {
        return Response.json({ data: { team: { labels: { nodes: [] } } } });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const task: Task = {
      id: 'tsk_1',
      title: 'Retry helper',
      description: 'd',
      status: 'review',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
      feedback: 'admission: deleted symbols: oldHelper',
      external: { linear: { id: 'iss_1', identifier: 'KON-1' } },
    };
    await new LinearIssueTracker('lin_test', 'KON', http).publishEvidence(task, {
      task_id: 'tsk_1',
      files_changed: [],
      checks: [],
      reviews: [],
      acceptance_criteria: [],
      verified: true,
      head_sha: 'abcdef1',
    });
    expect(posted).toContain('- Deleted symbols: oldHelper');
  });

  it('appends admission request ids onto the Linear proof comment', async () => {
    let posted = '';
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: string;
        variables?: { input?: { body?: string } };
      };
      if (body.query.includes('commentCreate')) {
        posted = body.variables?.input?.body ?? '';
        return Response.json({ data: { commentCreate: { success: true } } });
      }
      if (body.query.includes('teams {')) {
        return Response.json({ data: { teams: { nodes: [{ id: 'team_1', key: 'KON' }] } } });
      }
      if (body.query.includes('issue(id') && body.query.includes('comments')) {
        return Response.json({ data: { issue: { comments: { nodes: [] } } } });
      }
      if (body.query.includes('issue(id') && body.query.includes('labels { nodes')) {
        return Response.json({ data: { issue: { labels: { nodes: [] } } } });
      }
      if (body.query.includes('labels { nodes')) {
        return Response.json({ data: { team: { labels: { nodes: [] } } } });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const task: Task = {
      id: 'tsk_1',
      title: 'Retry helper',
      description: 'd',
      status: 'review',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
      external: { linear: { id: 'iss_1', identifier: 'KON-1' } },
    };
    await new LinearIssueTracker('lin_test', 'KON', http).publishEvidence(task, {
      task_id: 'tsk_1',
      files_changed: [],
      checks: [],
      reviews: [],
      acceptance_criteria: [],
      verified: true,
      head_sha: 'abcdef1',
      admission: {
        passed: true,
        incomplete: false,
        violations: [],
        admission_requests: ['adm_1', 'adm_2'],
        repo: 'ORCH',
        worktree: '/wt/task-a',
      } as never,
    });
    expect(posted).toContain('- Admission requests: adm_1, adm_2');
    expect(posted).toContain('- GitNexus repo: ORCH');
    expect(posted).toContain('- Worktree path: /wt/task-a');
  });

  it('keeps exactly one ORCH State label when status moves to In Progress', async () => {
    let labelIds: string[] = [];
    let comments = 0;
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: string;
        variables?: { labelIds?: string[] };
      };
      if (body.query.includes('commentCreate')) {
        comments += 1;
        return Response.json({ data: { commentCreate: { success: true } } });
      }
      if (body.query.includes('teams {')) {
        return Response.json({ data: { teams: { nodes: [{ id: 'team_1', key: 'KON' }] } } });
      }
      if (body.query.includes('states { nodes')) {
        return Response.json({
          data: { team: { states: { nodes: [{ id: 'st_progress', name: 'In Progress', type: 'started' }] } } },
        });
      }
      if (body.query.includes('issue(id') && body.query.includes('labels { nodes')) {
        return Response.json({
          data: {
            issue: {
              labels: {
                nodes: [
                  { id: 'lbl_orch', name: 'orch' },
                  { id: 'lbl_planned', name: 'ORCH State / Planned' },
                ],
              },
            },
          },
        });
      }
      if (body.query.includes('labels { nodes')) {
        return Response.json({
          data: {
            team: {
              labels: {
                nodes: [
                  { id: 'lbl_progress', name: 'ORCH State / In Progress' },
                  { id: 'lbl_planned', name: 'ORCH State / Planned' },
                ],
              },
            },
          },
        });
      }
      if (body.query.includes('issueUpdate') && body.variables?.labelIds) {
        labelIds = body.variables.labelIds;
        return Response.json({ data: { issueUpdate: { success: true } } });
      }
      if (body.query.includes('issueUpdate')) {
        return Response.json({ data: { issueUpdate: { success: true } } });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const task: Task = {
      id: 'tsk_1',
      title: 'Retry helper',
      description: 'd',
      status: 'in_progress',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
      external: { linear: { id: 'iss_1', identifier: 'KON-1' } },
    };
    await new LinearIssueTracker('lin_test', 'KON', http).onTaskStatusChanged(task, 'todo', 'in_progress');
    expect(comments).toBe(0);
    expect(labelIds).toContain('lbl_orch');
    expect(labelIds).toContain('lbl_progress');
    expect(labelIds).not.toContain('lbl_planned');
  });

  it('updates the existing Linear terminal comment instead of posting a second one', async () => {
    let created = 0;
    let updated = '';
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: string;
        variables?: { input?: { body?: string }; body?: string };
      };
      if (body.query.includes('comments { nodes')) {
        return Response.json({
          data: {
            issue: {
              comments: {
                nodes: [{ id: 'cmt_term', body: '<!-- orch-terminal:tsk_1 -->\n### Task failed\n\nFeedback: old' }],
              },
            },
          },
        });
      }
      if (body.query.includes('commentCreate')) {
        created += 1;
        return Response.json({ data: { commentCreate: { success: true } } });
      }
      if (body.query.includes('commentUpdate')) {
        updated = body.variables?.body ?? body.variables?.input?.body ?? '';
        return Response.json({ data: { commentUpdate: { success: true } } });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const task: Task = {
      id: 'tsk_1',
      title: 'Retry helper',
      description: 'd',
      status: 'failed',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 3,
      max_attempts: 3,
      feedback: 'worker crashed after retry',
      external: { linear: { id: 'iss_1', identifier: 'KON-1' } },
    };
    await new LinearIssueTracker('lin_test', 'KON', http).onTaskStatusChanged(task, 'in_progress', 'failed');
    expect(created).toBe(0);
    expect(updated).toContain('<!-- orch-terminal:tsk_1 -->');
    expect(updated).toContain('### Task failed');
    expect(updated).toContain('worker crashed after retry');
  });

  it('skips Linear workflow state writes when status_owner is linear-github', async () => {
    const previousApiKey = process.env['LINEAR_API_KEY'];
    process.env['LINEAR_API_KEY'] = 'lin_test';
    let stateId = '';
    let commentBody = '';
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: string;
        variables?: { input?: { body?: string }; stateId?: string };
      };
      if (body.query.includes('commentCreate')) {
        commentBody = body.variables?.input?.body ?? '';
        return Response.json({ data: { commentCreate: { success: true } } });
      }
      if (body.query.includes('teams {')) {
        return Response.json({ data: { teams: { nodes: [{ id: 'team_1', key: 'KON' }] } } });
      }
      if (body.query.includes('states { nodes')) {
        return Response.json({
          data: { team: { states: { nodes: [{ id: 'st_progress', name: 'In Progress', type: 'started' }] } } },
        });
      }
      if (body.query.includes('issueUpdate') && body.variables?.stateId) {
        stateId = body.variables.stateId;
        return Response.json({ data: { issueUpdate: { success: true } } });
      }
      if (body.query.includes('labels { nodes')) {
        return Response.json({ data: { team: { labels: { nodes: [] } } } });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const tracker = createLinearTracker({
      linear: { enabled: true, team_key: 'KON', status_owner: 'linear-github' },
    }, http);
    expect(tracker).not.toBeNull();
    const task: Task = {
      id: 'tsk_1',
      title: 'Retry helper',
      description: 'd',
      status: 'in_progress',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
      external: { linear: { id: 'iss_1', identifier: 'KON-1' } },
    };
    try {
      await tracker!.onTaskStatusChanged(task, 'todo', 'in_progress');
      expect(commentBody).toBe('');
      expect(stateId).toBe('');
    } finally {
      if (previousApiKey === undefined) delete process.env['LINEAR_API_KEY'];
      else process.env['LINEAR_API_KEY'] = previousApiKey;
    }
  });

  it('applies ORCH State / Blocked when admission or council feedback blocks the task', async () => {
    let commentBody = '';
    let labelIds: string[] = [];
    let stateId = '';
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: string;
        variables?: { input?: { body?: string }; labelIds?: string[]; stateId?: string };
      };
      if (body.query.includes('commentCreate')) {
        commentBody = body.variables?.input?.body ?? '';
        return Response.json({ data: { commentCreate: { success: true } } });
      }
      if (body.query.includes('comments { nodes')) {
        return Response.json({ data: { issue: { comments: { nodes: [] } } } });
      }
      if (body.query.includes('teams {')) {
        return Response.json({ data: { teams: { nodes: [{ id: 'team_1', key: 'KON' }] } } });
      }
      if (body.query.includes('states { nodes')) {
        return Response.json({
          data: { team: { states: { nodes: [{ id: 'st_blocked', name: 'Blocked' }] } } },
        });
      }
      if (body.query.includes('issue(id: $id)') && body.query.includes('labels { nodes')) {
        return Response.json({
          data: { issue: { labels: { nodes: [{ id: 'lbl_progress', name: 'ORCH State / In Progress' }] } } },
        });
      }
      if (body.query.includes('team(id: $id)') && body.query.includes('labels { nodes')) {
        return Response.json({
          data: {
            team: {
              labels: {
                nodes: [
                  { id: 'lbl_blocked', name: 'ORCH State / Blocked' },
                  { id: 'lbl_progress', name: 'ORCH State / In Progress' },
                ],
              },
            },
          },
        });
      }
      if (body.query.includes('issueUpdate') && body.variables?.labelIds) {
        labelIds = body.variables.labelIds;
        return Response.json({ data: { issueUpdate: { success: true } } });
      }
      if (body.query.includes('issueUpdate') && body.variables?.stateId) {
        stateId = body.variables.stateId;
        return Response.json({ data: { issueUpdate: { success: true } } });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const task: Task = {
      id: 'tsk_blocked',
      title: 'Retry helper',
      description: 'd',
      status: 'review',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
      feedback: 'CODE ADMISSION FAILED: unapproved new file',
      external: { linear: { id: 'iss_1', identifier: 'KON-1' } },
    };
    await new LinearIssueTracker('lin_test', 'KON', http).onTaskStatusChanged(task, 'in_progress', 'review');
    expect(commentBody).toContain('### Task blocked');
    expect(commentBody).toContain('<!-- orch-blocked:tsk_blocked -->');
    expect(labelIds).toContain('lbl_blocked');
    expect(labelIds).not.toContain('lbl_progress');
    expect(stateId).toBe('st_blocked');
  });

  it('refreshes the Linear §6.4 body when task status changes', async () => {
    const previousApiKey = process.env['LINEAR_API_KEY'];
    process.env['LINEAR_API_KEY'] = 'lin_test';
    const dir = mkdtempSync(path.join(tmpdir(), 'orch-linear-status-body-'));
    mkdirSync(path.join(dir, 'goals'), { recursive: true });
    writeFileSync(path.join(dir, 'goals', 'goal_1.yml'), 'id: goal_1\ntitle: Status Sync Goal\n');
    let updated = '';
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query: string;
        variables?: { input?: { title?: string; description?: string }; labelIds?: string[]; stateId?: string };
      };
      if (body.query.includes('issueUpdate') && body.variables?.input?.description) {
        updated = body.variables.input.description;
        return Response.json({ data: { issueUpdate: { success: true } } });
      }
      if (body.query.includes('teams {')) {
        return Response.json({ data: { teams: { nodes: [{ id: 'team_1', key: 'KON' }] } } });
      }
      if (body.query.includes('states { nodes')) {
        return Response.json({
          data: { team: { states: { nodes: [{ id: 'st_progress', name: 'In Progress', type: 'started' }] } } },
        });
      }
      if (body.query.includes('labels { nodes')) {
        return Response.json({
          data: { team: { labels: { nodes: [{ id: 'lbl_progress', name: 'ORCH State / In Progress' }] } } },
        });
      }
      if (body.query.includes('issueUpdate')) {
        return Response.json({ data: { issueUpdate: { success: true } } });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const tracker = createLinearTracker(
      { linear: { enabled: true, team_key: 'KON' } },
      http,
      dir,
    );
    try {
      await tracker!.onTaskStatusChanged({
        id: 'tsk_status_body',
        title: 'Retry helper',
        description: 'Reuse existing backoff',
        status: 'in_progress',
        priority: 3,
        labels: [],
        depends_on: [],
        created_at: 't',
        updated_at: 't',
        attempts: 0,
        max_attempts: 3,
        goalId: 'goal_1',
        acceptance_criteria: ['Status change keeps Linear current'],
        external: { linear: { id: 'iss_1', identifier: 'KON-1' } },
      }, 'todo', 'in_progress');
      expect(updated).toContain('Goal: `goal_1 / Status Sync Goal`');
      expect(updated).toContain('- [ ] Status change keeps Linear current');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      if (previousApiKey === undefined) delete process.env['LINEAR_API_KEY'];
      else process.env['LINEAR_API_KEY'] = previousApiKey;
    }
  });
});

describe('Linear credential store', () => {
  const previousTokenPath = process.env['ORCH_LINEAR_TOKEN_PATH'];
  const previousApiKey = process.env['LINEAR_API_KEY'];
  let dir: string;

  afterEach(() => {
    if (previousTokenPath === undefined) delete process.env['ORCH_LINEAR_TOKEN_PATH'];
    else process.env['ORCH_LINEAR_TOKEN_PATH'] = previousTokenPath;
    if (previousApiKey === undefined) delete process.env['LINEAR_API_KEY'];
    else process.env['LINEAR_API_KEY'] = previousApiKey;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('reads a stored key when LINEAR_API_KEY is unset', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'orch-linear-'));
    process.env['ORCH_LINEAR_TOKEN_PATH'] = path.join(dir, 'linear.token');
    delete process.env['LINEAR_API_KEY'];
    writeStoredLinearApiKey('lin_api_stored');
    expect(readStoredLinearApiKey()).toBe('lin_api_stored');
    expect(resolveLinearApiKey()).toBe('lin_api_stored');
    expect(createLinearTracker({ linear: { enabled: true } })).not.toBeNull();
  });

  it('lets LINEAR_API_KEY win over the stored file', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'orch-linear-'));
    process.env['ORCH_LINEAR_TOKEN_PATH'] = path.join(dir, 'linear.token');
    writeStoredLinearApiKey('lin_api_stored');
    process.env['LINEAR_API_KEY'] = 'lin_api_env';
    expect(resolveLinearApiKey()).toBe('lin_api_env');
  });

  it('resolves Linear label IDs once per team and name set', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'orch-linear-labels-'));
    process.env['ORCH_LINEAR_TOKEN_PATH'] = path.join(dir, 'linear.token');
    process.env['LINEAR_API_KEY'] = 'lin_test';
    let labelQueries = 0;
    let teamQueries = 0;
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { query: string };
      if (body.query.includes('issues(filter')) {
        return Response.json({ data: { issues: { nodes: [] } } });
      }
      if (body.query.includes('teams {')) {
        teamQueries += 1;
        return Response.json({ data: { teams: { nodes: [{ id: 'team_1', key: 'KON' }] } } });
      }
      if (body.query.includes('team(id: $id)') && body.query.includes('labels { nodes')) {
        labelQueries += 1;
        return Response.json({
          data: { team: { labels: { nodes: [{ id: 'lbl_orch', name: 'orch' }, { id: 'lbl_planned', name: 'ORCH State / Planned' }] } } },
        });
      }
      if (body.query.includes('issueCreate')) {
        return Response.json({
          data: { issueCreate: { success: true, issue: { id: `iss_${labelQueries}`, identifier: `KON-${labelQueries}`, url: 'https://linear.app/k/KON' } } },
        });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const tracker = createLinearTracker({ linear: { enabled: true, team_key: 'KON' } }, http, dir);
    expect(tracker).not.toBeNull();
    await tracker!.createForTask({
      id: 'tsk_label_a',
      title: 'Retry helper',
      description: 'd',
      status: 'todo',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
    });
    await tracker!.createForTask({
      id: 'tsk_label_b',
      title: 'Retry helper two',
      description: 'd',
      status: 'todo',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
    });
    expect(labelQueries).toBe(1);
    expect(teamQueries).toBe(1);
  });

  it('retries Linear HTTP 503 then succeeds', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'orch-linear-retry-'));
    process.env['ORCH_LINEAR_TOKEN_PATH'] = path.join(dir, 'linear.token');
    process.env['LINEAR_API_KEY'] = 'lin_test';
    let attempts = 0;
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      attempts += 1;
      if (attempts < 3) return new Response('unavailable', { status: 503 });
      const body = JSON.parse(String(init?.body ?? '{}')) as { query: string };
      if (body.query.includes('issues(filter')) {
        return Response.json({ data: { issues: { nodes: [] } } });
      }
      if (body.query.includes('teams {')) {
        return Response.json({ data: { teams: { nodes: [{ id: 'team_1', key: 'KON' }] } } });
      }
      if (body.query.includes('labels { nodes')) {
        return Response.json({
          data: { team: { labels: { nodes: [{ id: 'lbl_orch', name: 'orch' }, { id: 'lbl_planned', name: 'ORCH State / Planned' }] } } },
        });
      }
      if (body.query.includes('issueCreate')) {
        return Response.json({
          data: { issueCreate: { success: true, issue: { id: 'iss_1', identifier: 'KON-1', url: 'https://linear.app/k/KON-1' } } },
        });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const tracker = createLinearTracker({ linear: { enabled: true, team_key: 'KON' } }, http, dir);
    expect(tracker).not.toBeNull();
    const ref = await tracker!.createForTask({
      id: 'tsk_retry_http',
      title: 'Retry helper',
      description: 'd',
      status: 'todo',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
    });
    expect(ref.identifier).toBe('KON-1');
    expect(attempts).toBeGreaterThanOrEqual(3);
  });

  it('retries Linear abort/timeout then succeeds', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'orch-linear-abort-'));
    process.env['ORCH_LINEAR_TOKEN_PATH'] = path.join(dir, 'linear.token');
    process.env['LINEAR_API_KEY'] = 'lin_test';
    let attempts = 0;
    const http = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { query: string };
      if (body.query.includes('issues(filter')) {
        return Response.json({ data: { issues: { nodes: [] } } });
      }
      if (body.query.includes('teams {')) {
        return Response.json({ data: { teams: { nodes: [{ id: 'team_1', key: 'KON' }] } } });
      }
      if (body.query.includes('labels { nodes')) {
        return Response.json({
          data: { team: { labels: { nodes: [{ id: 'lbl_orch', name: 'orch' }, { id: 'lbl_planned', name: 'ORCH State / Planned' }] } } },
        });
      }
      if (body.query.includes('issueCreate')) {
        return Response.json({
          data: { issueCreate: { success: true, issue: { id: 'iss_1', identifier: 'KON-1', url: 'https://linear.app/k/KON-1' } } },
        });
      }
      return Response.json({ data: {} });
    }) as typeof fetch;
    const tracker = createLinearTracker({ linear: { enabled: true, team_key: 'KON' } }, http, dir);
    expect(tracker).not.toBeNull();
    const ref = await tracker!.createForTask({
      id: 'tsk_retry_abort',
      title: 'Retry helper',
      description: 'd',
      status: 'todo',
      priority: 3,
      labels: [],
      depends_on: [],
      created_at: 't',
      updated_at: 't',
      attempts: 0,
      max_attempts: 3,
    });
    expect(ref.identifier).toBe('KON-1');
    expect(attempts).toBeGreaterThanOrEqual(3);
  });

  it('returns no tracker when Linear is enabled but no credential exists', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'orch-linear-'));
    process.env['ORCH_LINEAR_TOKEN_PATH'] = path.join(dir, 'missing.token');
    delete process.env['LINEAR_API_KEY'];
    expect(createLinearTracker({ linear: { enabled: true } })).toBeNull();
    clearStoredLinearApiKey();
    expect(readStoredLinearApiKey()).toBe('');
  });
});
