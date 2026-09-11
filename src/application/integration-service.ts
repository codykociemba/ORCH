/**
 * Watches ORCH events and mirrors tasks to Linear via the outbox.
 */

import type { EventBus } from './event-bus.js';
import type { ITaskStore } from '../infrastructure/storage/interfaces.js';
import type { OutboxStore } from '../infrastructure/integrations/outbox-store.js';
import type { IIssueTracker } from '../domain/integration.js';
import type { Task } from '../domain/task.js';
import type { VerificationEvidence } from '../domain/evidence.js';
import type { WorkflowConfig } from '../domain/workflow-config.js';

export class IntegrationService {
  constructor(
    private readonly taskStore: ITaskStore,
    private readonly outbox: OutboxStore,
    private readonly eventBus: EventBus,
    private readonly workflow: WorkflowConfig | null,
    private readonly tracker: IIssueTracker | null,
  ) {}

  enabled(): boolean {
    return this.workflow?.linear?.enabled === true && this.tracker !== null;
  }

  requiredBeforeDispatch(): boolean {
    return this.workflow?.linear?.required_before_dispatch === true;
  }

  subscribe(): void {
    this.eventBus.on('task:created', (event) => {
      void this.onTaskCreated(event.task);
    });
    this.eventBus.on('task:status_changed', (event) => {
      void this.onStatus(event.taskId, event.from, event.to);
    });
    this.eventBus.on('task:assigned', (event) => {
      void this.onAssigned(event.taskId, event.agentId);
    });
  }

  async onTaskCreated(task: Task): Promise<void> {
    if (!this.enabled()) return;
    const fingerprint = `linear.create:${task.id}`;
    const entry = await this.outbox.enqueue({
      kind: 'linear.create',
      task_id: task.id,
      fingerprint,
    });
    if (entry.status === 'done') return;
    await this.attemptCreate(task, entry.id);
  }

  async retry(taskId: string): Promise<Task> {
    const task = await this.taskStore.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.external?.linear?.id) return task;
    const entry = await this.outbox.enqueue({
      kind: 'linear.retry',
      task_id: taskId,
      fingerprint: `linear.create:${taskId}`,
    });
    await this.attemptCreate(task, entry.id);
    const updated = await this.taskStore.get(taskId);
    if (!updated) throw new Error(`Task not found: ${taskId}`);
    return updated;
  }

  async publishProof(task: Task, evidence: VerificationEvidence): Promise<void> {
    if (!this.tracker) return;
    await this.tracker.publishEvidence(task, evidence);
  }

  async onMerged(task: Task, merge: import('../domain/integration.js').MergeEvidence): Promise<void> {
    if (!this.tracker) return;
    await this.tracker.onMerged(task, merge);
  }

  async recordReview(task: Task, review: import('../domain/evidence.js').ReviewEvidence): Promise<void> {
    task.reviews = [
      ...(task.reviews ?? []).filter((item) => item.commit_sha !== review.commit_sha || item.reviewer_type !== review.reviewer_type),
      review,
    ];
    task.updated_at = new Date().toISOString();
    await this.taskStore.save(task);
    if (this.tracker) {
      await this.tracker.onReview(task, review);
    }
  }

  async linkPullRequest(task: Task, url: string, number?: number): Promise<Task> {
    task.external = {
      ...task.external,
      github: {
        ...task.external?.github,
        pr_url: url,
        pr_number: number ?? task.external?.github?.pr_number,
      },
    };
    task.updated_at = new Date().toISOString();
    await this.taskStore.save(task);
    if (this.tracker && number !== undefined) {
      await this.tracker.onPullRequestLinked(task, {
        provider: 'github',
        number,
        url,
      });
    }
    return task;
  }

  private async attemptCreate(task: Task, outboxId: string): Promise<void> {
    const entry = await this.outbox.get(outboxId);
    if (!entry || !this.tracker || entry.status === 'done') return;
    entry.attempts += 1;
    try {
      const ref = await this.tracker.createForTask(task);
      const latest = await this.taskStore.get(task.id);
      if (latest) {
        latest.external = {
          ...latest.external,
          linear: {
            id: ref.id,
            identifier: ref.identifier,
            url: ref.url,
          },
        };
        latest.updated_at = new Date().toISOString();
        await this.taskStore.save(latest);
      }
      entry.status = 'done';
      delete entry.last_error;
    } catch (err) {
      entry.status = 'failed';
      entry.last_error = err instanceof Error ? err.message : String(err);
    }
    await this.outbox.save(entry);
  }

  private async onStatus(taskId: string, from: Task['status'], to: Task['status']): Promise<void> {
    if (!this.tracker) return;
    const task = await this.taskStore.get(taskId);
    if (!task?.external?.linear) return;
    await this.tracker.onTaskStatusChanged(task, from, to);
  }

  private async onAssigned(taskId: string, agentId: string): Promise<void> {
    if (!this.tracker) return;
    const task = await this.taskStore.get(taskId);
    if (!task?.external?.linear) return;
    await this.tracker.onTaskAssigned(task, {
      id: agentId,
      name: task.assignee ?? agentId,
      adapter: 'unknown',
      status: 'running',
      config: { approval_policy: 'auto', max_turns: 50, timeout_ms: 3_600_000, stall_timeout_ms: 300_000 },
      stats: { tasks_completed: 0, tasks_failed: 0, total_runs: 0, total_runtime_ms: 0 },
    });
  }
}
