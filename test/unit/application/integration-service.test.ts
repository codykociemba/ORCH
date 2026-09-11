import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { IntegrationService } from '../../../src/application/integration-service.js';
import { EventBus } from '../../../src/application/event-bus.js';
import { OutboxStore } from '../../../src/infrastructure/integrations/outbox-store.js';
import { Paths } from '../../../src/infrastructure/storage/paths.js';
import { createMockTaskStore, makeTask } from './helpers.js';
import type { IIssueTracker } from '../../../src/domain/integration.js';

function mockTracker(): IIssueTracker & { createForTask: ReturnType<typeof vi.fn> } {
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
  };
}

describe('IntegrationService', () => {
  it('creates a Linear issue once and retries reuse the same fingerprint', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-int-'));
    try {
      const task = makeTask({ id: 'tsk_lin1', title: 'Retry helper' });
      const taskStore = createMockTaskStore([task]);
      const tracker = mockTracker();
      const service = new IntegrationService(
        taskStore,
        new OutboxStore(new Paths(root)),
        new EventBus(),
        { version: 1, linear: { enabled: true, required_before_dispatch: true } },
        tracker,
      );

      await service.onTaskCreated(task);
      await service.retry('tsk_lin1');

      expect(tracker.createForTask).toHaveBeenCalledTimes(1);
      const saved = await taskStore.get('tsk_lin1');
      expect(saved?.external?.linear?.identifier).toBe('ENG-142');
      expect(service.requiredBeforeDispatch()).toBe(true);

      await service.linkPullRequest(saved!, 'https://github.com/org/repo/pull/9', 9);
      expect(tracker.onPullRequestLinked).toHaveBeenCalled();

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
});
