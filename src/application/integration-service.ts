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
    void this.replayPending();
    this.eventBus.on('integration:sync_failed', (event) => {
      if (!event.taskId) return;
      const note = event.error.trim();
      if (!note) return;
      void this.taskStore.get(event.taskId).then((task) => {
        if (!task || task.feedback?.includes(note)) return;
        task.feedback = [task.feedback, note].filter(Boolean).join('\n');
        task.updated_at = new Date().toISOString();
        return this.taskStore.save(task);
      });
    });
    this.eventBus.on('task:created', (event) => {
      if (this.workflow?.linear?.enabled === true && !this.tracker) {
        this.eventBus.emit({
          type: 'integration:sync_failed',
          provider: 'linear',
          taskId: event.task.id,
          error: 'Linear login required — orch integration login',
        });
        void this.taskStore.get(event.task.id).then((task) => {
          if (!task || task.feedback?.includes('Linear login required')) return;
          task.feedback = [task.feedback, 'Linear login required — orch integration login'].filter(Boolean).join('\n');
          task.updated_at = new Date().toISOString();
          return this.taskStore.save(task);
        });
        return;
      }
      void this.onTaskCreated(event.task).then(async () => {
        if (!this.enabled()) return;
        const latest = await this.taskStore.get(event.task.id);
        const created = latest?.external?.linear;
        if (created) {
          if (!event.task.external?.linear) {
            this.eventBus.emit({
              type: 'integration:linear_issue_created',
              taskId: latest.id,
              identifier: created.identifier ?? created.id,
            });
          }
          await this.linkTaskDependencies(latest);
          return;
        }
        this.eventBus.emit({
          type: 'integration:sync_failed',
          provider: 'linear',
          taskId: event.task.id,
          error: 'Linear issue was not created',
        });
        if (latest && !latest.feedback?.includes('Linear issue was not created')) {
          latest.feedback = [latest.feedback, 'Linear issue was not created'].filter(Boolean).join('\n');
          latest.updated_at = new Date().toISOString();
          await this.taskStore.save(latest);
        }
      });
    });
    this.eventBus.on('task:status_changed', (event) => {
      void this.onStatus(event.taskId, event.from, event.to).then(async () => {
        if (!this.tracker) return;
        const task = await this.taskStore.get(event.taskId);
        if (!task?.external?.linear) return;
        this.eventBus.emit({
          type: 'integration:linear_issue_updated',
          taskId: event.taskId,
          identifier: task.external.linear.identifier,
          from: event.from,
          to: event.to,
        });
      });
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
    if (entry.status === 'done') {
      const latest = await this.taskStore.get(task.id);
      if (latest) await this.linkTaskDependencies(latest);
      return;
    }
    await this.attemptCreate(task, entry.id);
    const created = await this.taskStore.get(task.id);
    if (created) await this.linkTaskDependencies(created);
  }

  async retry(taskId: string): Promise<Task> {
    const task = await this.taskStore.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.external?.linear?.id) return task;
    this.eventBus.emit({ type: 'integration:sync_retry', provider: 'linear', taskId });
    const entry = await this.outbox.enqueue({
      kind: 'linear.retry',
      task_id: taskId,
      fingerprint: `linear.create:${taskId}`,
    });
    await this.attemptCreate(task, entry.id);
    const updated = await this.taskStore.get(taskId);
    if (!updated) throw new Error(`Task not found: ${taskId}`);
    if (updated.external?.linear) {
      this.eventBus.emit({
        type: 'integration:linear_issue_created',
        taskId,
        identifier: updated.external.linear.identifier ?? updated.external.linear.id,
      });
      await this.linkTaskDependencies(updated);
    } else {
      this.eventBus.emit({
        type: 'integration:sync_failed',
        provider: 'linear',
        taskId,
        error: 'Linear retry did not create an issue',
      });
    }
    return updated;
  }

  async publishProof(task: Task, evidence: VerificationEvidence): Promise<void> {
    if (!this.tracker) return;
    await this.tracker.publishEvidence(task, evidence);
    this.eventBus.emit({
      type: 'integration:proof_published',
      taskId: task.id,
      headSha: evidence.head_sha ?? '',
    });
    this.eventBus.emit({
      type: 'integration:linear_comment_published',
      taskId: task.id,
      kind: 'proof',
    });
  }

  async onMerged(task: Task, merge: import('../domain/integration.js').MergeEvidence): Promise<void> {
    if (!this.tracker) return;
    await this.tracker.onMerged(task, merge);
    this.eventBus.emit({
      type: 'integration:linear_comment_published',
      taskId: task.id,
      kind: 'merge',
    });
    if (task.external?.linear) {
      this.eventBus.emit({
        type: 'integration:linear_issue_updated',
        taskId: task.id,
        identifier: task.external.linear.identifier,
        to: 'done',
      });
    }
    this.eventBus.emit({ type: 'github:pr_merged', taskId: task.id, sha: merge.sha });
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
      this.eventBus.emit({
        type: 'integration:linear_comment_published',
        taskId: task.id,
        kind: 'review',
      });
    }
    this.eventBus.emit({
      type: 'github:pr_reviewed',
      taskId: task.id,
      verdict: review.verdict,
      sha: review.commit_sha,
    });
  }

  async linkPullRequest(task: Task, url: string, number?: number): Promise<Task> {
    const existed = Boolean(task.external?.github?.pr_url);
    task.external = {
      ...task.external,
      github: {
        ...task.external?.github,
        pr_url: url,
        pr_number: number ?? task.external?.github?.pr_number,
      },
    };
    if (task.proof) task.proof = { ...task.proof, pr_url: url };
    task.updated_at = new Date().toISOString();
    await this.taskStore.save(task);
    if (this.tracker && number !== undefined) {
      await this.tracker.onPullRequestLinked(task, {
        provider: 'github',
        number,
        url,
        branch: task.proof?.branch,
        head_sha: task.proof?.head_sha,
      });
    }
    this.eventBus.emit({
      type: 'integration:github_pr_linked',
      taskId: task.id,
      url,
      number,
    });
    this.eventBus.emit({
      type: existed ? 'github:pr_updated' : 'github:pr_created',
      taskId: task.id,
      url,
      number,
    });
    if (task.proof?.head_sha) {
      await this.publishProof(task, {
        task_id: task.id,
        plan_id: task.plan_id,
        plan_unit_id: task.plan_unit_id,
        branch: task.proof.branch,
        pr_url: url,
        head_sha: task.proof.head_sha,
        files_changed: task.proof.files_changed ?? [],
        checks: [],
        reviews: task.reviews ?? [],
        acceptance_criteria: (task.acceptance_criteria ?? []).map((description) => ({
          description,
          passed: task.proof?.verified === true,
        })),
        verified: task.proof.verified === true,
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

  private async linkTaskDependencies(task: Task): Promise<void> {
    const tracker = this.tracker;
    if (!canLinkBlockedBy(tracker)) return;
    const issueId = task.external?.linear?.id;
    if (!issueId) return;
    const blockers: string[] = [];
    const lines: string[] = [];
    for (const depId of task.depends_on) {
      const dep = await this.taskStore.get(depId);
      const blockerId = dep?.external?.linear?.id;
      const ident = dep?.external?.linear?.identifier;
      if (blockerId) blockers.push(blockerId);
      lines.push(ident ? `- ${depId} (${ident})` : `- ${depId}`);
    }
    if (blockers.length > 0) await tracker.linkBlockedBy(issueId, blockers);
    if (lines.length > 0) await tracker.refreshDependencyDescription(issueId, lines);
    const others = await this.taskStore.list();
    for (const other of others) {
      if (!other.depends_on.includes(task.id) || !other.external?.linear?.id) continue;
      await tracker.linkBlockedBy(other.external.linear.id, [issueId]);
      const otherLines: string[] = [];
      for (const depId of other.depends_on) {
        const dep = depId === task.id ? task : await this.taskStore.get(depId);
        const ident = dep?.external?.linear?.identifier ?? (depId === task.id ? task.external?.linear?.identifier : undefined);
        otherLines.push(ident ? `- ${depId} (${ident})` : `- ${depId}`);
      }
      await tracker.refreshDependencyDescription(other.external.linear.id, otherLines);
    }
  }

  /** Watcher restart: finish pending/failed Linear creates without duplicating done issues. */
  private async replayPending(): Promise<void> {
    if (!this.enabled()) return;
    const { outboxRetryDue } = await import('../infrastructure/integrations/outbox-store.js');
    const entries = [
      ...await this.outbox.list('pending'),
      ...await this.outbox.list('failed'),
    ];
    for (const entry of entries) {
      if (!entry.kind.startsWith('linear.')) continue;
      if (!outboxRetryDue(entry)) continue;
      const task = await this.taskStore.get(entry.task_id);
      if (!task || task.external?.linear?.id) continue;
      await this.retry(task.id);
    }
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

function canLinkBlockedBy(
  tracker: IIssueTracker | null,
): tracker is IIssueTracker & {
  linkBlockedBy: (issueId: string, blockerIds: string[]) => Promise<void>;
  refreshDependencyDescription: (issueId: string, lines: string[]) => Promise<void>;
} {
  return tracker !== null
    && 'linkBlockedBy' in tracker
    && typeof (tracker as { linkBlockedBy?: unknown }).linkBlockedBy === 'function'
    && 'refreshDependencyDescription' in tracker
    && typeof (tracker as { refreshDependencyDescription?: unknown }).refreshDependencyDescription === 'function';
}
