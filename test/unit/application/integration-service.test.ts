import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IntegrationService } from '../../../src/application/integration-service.js';
import { EventBus } from '../../../src/application/event-bus.js';
import { OutboxStore, outboxRetryDue } from '../../../src/infrastructure/integrations/outbox-store.js';
import { Paths } from '../../../src/infrastructure/storage/paths.js';
import { createMockTaskStore, makeTask } from './helpers.js';
import type { IIssueTracker } from '../../../src/domain/integration.js';

function mockTracker(): IIssueTracker & {
  createForTask: ReturnType<typeof vi.fn>;
  linkBlockedBy: ReturnType<typeof vi.fn>;
  refreshDependencyDescription: ReturnType<typeof vi.fn>;
} {
  return {
    createForTask: vi.fn(async (task) => ({
      provider: 'linear' as const,
      id: 'iss_1',
      identifier: 'ENG-142',
      url: 'https://linear.app/x/ENG-142',
      synced_at: '2026-01-01T00:00:00Z',
    })),
    onTaskAssigned: vi.fn(async () => {}),
    onTaskStatusChanged: vi.fn(async () => {}),
    onPullRequestLinked: vi.fn(async () => {}),
    publishEvidence: vi.fn(async () => {}),
    onReview: vi.fn(async () => {}),
    onMerged: vi.fn(async () => {}),
    linkBlockedBy: vi.fn(async () => {}),
    refreshDependencyDescription: vi.fn(async () => {}),
  };
}

describe('IntegrationService', () => {
  it('creates a Linear issue once and retries reuse the same fingerprint', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-int-'));
    try {
      const task = makeTask({ id: 'tsk_lin1', title: 'Retry helper' });
      const taskStore = createMockTaskStore([task]);
      const tracker = mockTracker();
      const bus = new EventBus();
      const service = new IntegrationService(
        taskStore,
        new OutboxStore(new Paths(root)),
        bus,
        { version: 1, linear: { enabled: true, required_before_dispatch: true } },
        tracker,
      );

      await service.onTaskCreated(task);
      await service.retry('tsk_lin1');

      expect(tracker.createForTask).toHaveBeenCalledTimes(1);
      const saved = await taskStore.get('tsk_lin1');
      expect(saved?.external?.linear?.identifier).toBe('ENG-142');
      expect(service.requiredBeforeDispatch()).toBe(true);

      const events: string[] = [];
      bus.onAny((event) => { events.push(event.type); });

      await service.linkPullRequest(saved!, 'https://github.com/org/repo/pull/9', 9);
      expect(tracker.onPullRequestLinked).toHaveBeenCalled();
      expect(events).toContain('integration:github_pr_linked');

      await service.publishProof(saved!, {
        task_id: 'tsk_lin1',
        head_sha: 'abc123',
        files_changed: [],
        checks: [],
        reviews: [],
        acceptance_criteria: [],
        verified: true,
      });
      expect(tracker.publishEvidence).toHaveBeenCalled();
      expect(events).toContain('integration:proof_published');
      expect(events).toContain('integration:linear_comment_published');

      await service.recordReview(saved!, {
        reviewer_type: 'cursor',
        commit_sha: 'abc123',
        verdict: 'approve',
        summary: 'ok',
        timestamp: '2026-01-01T00:00:00Z',
      });
      expect(tracker.onReview).toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('mirrors the spec Linear/GitHub lifecycle: create, start, PR, proof, review, merge', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-int-life-'));
    try {
      const task = makeTask({
        id: 'tsk_life',
        title: 'Lifecycle',
        status: 'todo',
        external: {},
      });
      const taskStore = createMockTaskStore([task]);
      const tracker = mockTracker();
      const bus = new EventBus();
      const events: string[] = [];
      bus.onAny((event) => { events.push(event.type); });
      const service = new IntegrationService(
        taskStore,
        new OutboxStore(new Paths(root)),
        bus,
        { version: 1, linear: { enabled: true, required_before_dispatch: true } },
        tracker,
      );
      service.subscribe();

      bus.emit({ type: 'task:created', task });
      await vi.waitFor(() => {
        expect(tracker.createForTask).toHaveBeenCalledTimes(1);
        expect(events).toContain('integration:linear_issue_created');
      });
      const created = await taskStore.get('tsk_life');
      expect(created?.external?.linear?.identifier).toBe('ENG-142');

      bus.emit({ type: 'task:status_changed', taskId: 'tsk_life', from: 'todo', to: 'in_progress' });
      await vi.waitFor(() => {
        expect(tracker.onTaskStatusChanged).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'tsk_life' }),
          'todo',
          'in_progress',
        );
        expect(events).toContain('integration:linear_issue_updated');
      });

      const linked = await service.linkPullRequest(
        created!,
        'https://github.com/org/repo/pull/9',
        9,
      );
      expect(linked.external?.github?.pr_number).toBe(9);
      expect(tracker.onPullRequestLinked).toHaveBeenCalled();
      expect(events).toContain('integration:github_pr_linked');
      expect(events).toContain('github:pr_created');

      bus.emit({ type: 'task:status_changed', taskId: 'tsk_life', from: 'in_progress', to: 'review' });
      await vi.waitFor(() => {
        expect(tracker.onTaskStatusChanged).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'tsk_life' }),
          'in_progress',
          'review',
        );
      });

      await service.publishProof(linked, {
        task_id: 'tsk_life',
        head_sha: 'abc123',
        files_changed: [],
        checks: [{ name: 'typecheck', command: 'tsc', status: 'passed' }],
        reviews: [],
        acceptance_criteria: [],
        verified: true,
      });
      expect(tracker.publishEvidence).toHaveBeenCalled();
      expect(events).toContain('integration:proof_published');

      await service.recordReview(linked, {
        reviewer_type: 'cursor',
        commit_sha: 'abc123',
        verdict: 'approve',
        summary: 'ok',
        timestamp: '2026-01-01T00:00:00Z',
      });
      expect(tracker.onReview).toHaveBeenCalled();
      expect(events).toContain('github:pr_reviewed');

      await service.onMerged(linked, {
        sha: 'abc123',
        url: 'https://github.com/org/repo/pull/9',
        merged_at: '2026-01-01T00:00:00Z',
      });
      expect(tracker.onMerged).toHaveBeenCalled();
      expect(events).toContain('integration:linear_comment_published');
      expect(events).toContain('github:pr_merged');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('emits linear_issue_created after a subscribed task create', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-int-evt-'));
    try {
      const task = makeTask({ id: 'tsk_lin2', title: 'Event create' });
      const taskStore = createMockTaskStore([task]);
      const bus = new EventBus();
      const events: string[] = [];
      bus.onAny((event) => { events.push(event.type); });
      const service = new IntegrationService(
        taskStore,
        new OutboxStore(new Paths(root)),
        bus,
        { version: 1, linear: { enabled: true, required_before_dispatch: false } },
        mockTracker(),
      );
      service.subscribe();
      bus.emit({ type: 'task:created', task });
      await vi.waitFor(() => {
        expect(events).toContain('integration:linear_issue_created');
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retries a timed-out Linear create without duplicating the issue', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-int-timeout-'));
    try {
      const task = makeTask({ id: 'tsk_to', title: 'Timeout' });
      const taskStore = createMockTaskStore([task]);
      const tracker = mockTracker();
      tracker.createForTask
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce({
          provider: 'linear',
          id: 'iss_1',
          identifier: 'ENG-142',
          url: 'https://linear.app/x/ENG-142',
          synced_at: '2026-01-01T00:00:00Z',
        });
      const service = new IntegrationService(
        taskStore,
        new OutboxStore(new Paths(root)),
        new EventBus(),
        { version: 1, linear: { enabled: true } },
        tracker,
      );
      await service.onTaskCreated(task);
      expect((await taskStore.get('tsk_to'))?.external?.linear).toBeUndefined();
      const retried = await service.retry('tsk_to');
      expect(retried.external?.linear?.identifier).toBe('ENG-142');
      expect(tracker.createForTask).toHaveBeenCalledTimes(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('ignores duplicate task:created delivery after the issue exists', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-int-dup-'));
    try {
      const task = makeTask({ id: 'tsk_dup', title: 'Dup' });
      const taskStore = createMockTaskStore([task]);
      const tracker = mockTracker();
      const bus = new EventBus();
      const service = new IntegrationService(
        taskStore,
        new OutboxStore(new Paths(root)),
        bus,
        { version: 1, linear: { enabled: true } },
        tracker,
      );
      service.subscribe();
      bus.emit({ type: 'task:created', task });
      await vi.waitFor(() => expect(tracker.createForTask).toHaveBeenCalledTimes(1));
      const created = await taskStore.get('tsk_dup');
      bus.emit({ type: 'task:created', task: created! });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(tracker.createForTask).toHaveBeenCalledTimes(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('replays a pending outbox entry when the watcher restarts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-int-replay-'));
    try {
      const task = makeTask({ id: 'tsk_replay', title: 'Replay' });
      const taskStore = createMockTaskStore([task]);
      const paths = new Paths(root);
      const failing = mockTracker();
      failing.createForTask.mockRejectedValue(new Error('timeout'));
      const failedService = new IntegrationService(
        taskStore,
        new OutboxStore(paths),
        new EventBus(),
        { version: 1, linear: { enabled: true } },
        failing,
      );
      await failedService.onTaskCreated(task);
      const failed = (await new OutboxStore(paths).list('failed'))[0];
      expect(failed).toBeDefined();
      const { writeJson } = await import('../../../src/infrastructure/storage/fs-utils.js');
      await writeJson(paths.outboxPath(failed!.id), {
        ...failed,
        updated_at: '2020-01-01T00:00:00.000Z',
      });

      const tracker = mockTracker();
      const restarted = new IntegrationService(
        taskStore,
        new OutboxStore(paths),
        new EventBus(),
        { version: 1, linear: { enabled: true } },
        tracker,
      );
      restarted.subscribe();
      await vi.waitFor(() => {
        expect(tracker.createForTask).toHaveBeenCalled();
      });
      expect((await taskStore.get('tsk_replay'))?.external?.linear?.identifier).toBe('ENG-142');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('notifies Linear for a second PR on the same task and for one PR on two plan units', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-int-prs-'));
    try {
      const a = makeTask({ id: 'tsk_a', title: 'A', plan_unit_id: 'U-01' });
      const b = makeTask({ id: 'tsk_b', title: 'B', plan_unit_id: 'U-02' });
      const taskStore = createMockTaskStore([a, b]);
      const tracker = mockTracker();
      const service = new IntegrationService(
        taskStore,
        new OutboxStore(new Paths(root)),
        new EventBus(),
        { version: 1, linear: { enabled: true } },
        tracker,
      );
      await service.onTaskCreated(a);
      await service.onTaskCreated(b);
      const first = await taskStore.get('tsk_a');
      const second = await taskStore.get('tsk_b');
      await service.linkPullRequest(first!, 'https://github.com/org/repo/pull/9', 9);
      await service.linkPullRequest(first!, 'https://github.com/org/repo/pull/10', 10);
      await service.linkPullRequest(second!, 'https://github.com/org/repo/pull/9', 9);
      expect(tracker.onPullRequestLinked).toHaveBeenCalledTimes(3);
      expect((await taskStore.get('tsk_a'))?.external?.github?.pr_number).toBe(10);
      expect((await taskStore.get('tsk_b'))?.external?.github?.pr_number).toBe(9);
      expect(tracker.publishEvidence).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('relates Linear issues as blockedBy once dependency issues exist', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-int-rel-'));
    try {
      const dep = makeTask({
        id: 'tsk_dep',
        title: 'Dep',
        external: { linear: { id: 'iss_dep', identifier: 'ENG-1' } },
      });
      const child = makeTask({ id: 'tsk_child', title: 'Child', depends_on: ['tsk_dep'] });
      const later = makeTask({
        id: 'tsk_later',
        title: 'Later',
        depends_on: ['tsk_new'],
        external: { linear: { id: 'iss_later', identifier: 'ENG-9' } },
      });
      const neu = makeTask({ id: 'tsk_new', title: 'New dep' });
      const taskStore = createMockTaskStore([dep, child, later, neu]);
      const tracker = mockTracker();
      const service = new IntegrationService(
        taskStore,
        new OutboxStore(new Paths(root)),
        new EventBus(),
        { version: 1, linear: { enabled: true } },
        tracker,
      );

      await service.onTaskCreated(child);
      expect(tracker.linkBlockedBy).toHaveBeenCalledWith('iss_1', ['iss_dep']);
      expect(tracker.refreshDependencyDescription).toHaveBeenCalledWith('iss_1', ['- tsk_dep (ENG-1)']);

      await service.onTaskCreated(neu);
      expect(tracker.linkBlockedBy).toHaveBeenCalledWith('iss_later', ['iss_1']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('backs off Linear outbox drain after a failed attempt', () => {
    const now = Date.parse('2026-01-01T00:00:02.000Z');
    expect(outboxRetryDue({
      status: 'pending',
      attempts: 0,
      updated_at: '2026-01-01T00:00:01.000Z',
    }, now)).toBe(true);
    expect(outboxRetryDue({
      status: 'failed',
      attempts: 1,
      updated_at: '2026-01-01T00:00:01.000Z',
    }, now)).toBe(false);
    expect(outboxRetryDue({
      status: 'failed',
      attempts: 1,
      updated_at: '2026-01-01T00:00:00.000Z',
    }, now)).toBe(true);
  });

  it('publishes a proof snapshot and github:pr_updated when a later PR is linked', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-int-snap-'));
    try {
      const task = makeTask({
        id: 'tsk_snap',
        proof: { files_changed: ['src/a.ts'], head_sha: 'abc1234', branch: 'orch/tsk_snap', verified: false },
        external: { github: { pr_url: 'https://github.com/org/repo/pull/8', pr_number: 8 } },
      });
      const taskStore = createMockTaskStore([task]);
      const tracker = mockTracker();
      const bus = new EventBus();
      const events: string[] = [];
      bus.onAny((event) => { events.push(event.type); });
      const service = new IntegrationService(
        taskStore,
        new OutboxStore(new Paths(root)),
        bus,
        { version: 1, linear: { enabled: true } },
        tracker,
      );
      await service.linkPullRequest(task, 'https://github.com/org/repo/pull/9', 9);
      expect(events).toContain('github:pr_updated');
      expect(tracker.publishEvidence).toHaveBeenCalled();
      expect(events).toContain('integration:proof_published');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('surfaces missing Linear login instead of failing silently on create', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-int-login-'));
    try {
      const bus = new EventBus();
      const events: Array<{ type: string; error?: string }> = [];
      bus.onAny((event) => {
        events.push({
          type: event.type,
          error: 'error' in event ? String(event.error) : undefined,
        });
      });
      const task = makeTask({ id: 'tsk_nologin' });
      const taskStore = createMockTaskStore([task]);
      const service = new IntegrationService(
        taskStore,
        new OutboxStore(new Paths(root)),
        bus,
        { version: 1, linear: { enabled: true } },
        null,
      );
      service.subscribe();
      bus.emit({ type: 'task:created', task });
      expect(events.some((event) => (
        event.type === 'integration:sync_failed'
        && event.error?.includes('login required')
      ))).toBe(true);
      await vi.waitFor(async () => {
        const saved = await taskStore.get('tsk_nologin');
        expect(saved?.feedback).toMatch(/Linear login required/);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists outbox drain Linear failures onto the task', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-int-drain-'));
    try {
      const task = makeTask({ id: 'tsk_drain' });
      const taskStore = createMockTaskStore([task]);
      const bus = new EventBus();
      const service = new IntegrationService(
        taskStore,
        new OutboxStore(new Paths(root)),
        bus,
        { version: 1, linear: { enabled: true } },
        mockTracker(),
      );
      service.subscribe();
      bus.emit({
        type: 'integration:sync_failed',
        provider: 'linear',
        taskId: 'tsk_drain',
        error: 'Proof has no HEAD SHA — cannot publish Verified comment',
      });
      await vi.waitFor(async () => {
        const saved = await taskStore.get('tsk_drain');
        expect(saved?.feedback).toMatch(/HEAD SHA/);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
