/**
 * External issue tracker + GitHub PR refs.
 */

import type { Task, TaskStatus } from './task.js';
import type { Agent } from './agent.js';
import type { ReviewEvidence, VerificationEvidence } from './evidence.js';

export interface ExternalIssueRef {
  provider: 'linear';
  id: string;
  identifier: string;
  url: string;
  synced_at: string;
}

export interface PullRequestRef {
  provider: 'github';
  number: number;
  url: string;
  branch?: string;
  head_sha?: string;
}

export interface MergeEvidence {
  sha: string;
  url?: string;
  merged_at: string;
}

export interface IIssueTracker {
  createForTask(task: Task): Promise<ExternalIssueRef>;
  onTaskAssigned(task: Task, agent: Agent): Promise<void>;
  onTaskStatusChanged(task: Task, from: TaskStatus, to: TaskStatus): Promise<void>;
  onPullRequestLinked(task: Task, pr: PullRequestRef): Promise<void>;
  publishEvidence(task: Task, evidence: VerificationEvidence): Promise<void>;
  onReview(task: Task, review: ReviewEvidence): Promise<void>;
  onMerged(task: Task, merge: MergeEvidence): Promise<void>;
}

export type OutboxStatus = 'pending' | 'done' | 'failed';

export interface OutboxEntry {
  id: string;
  kind: 'linear.create' | 'linear.status' | 'linear.pr' | 'linear.proof' | 'linear.retry';
  task_id: string;
  fingerprint: string;
  attempts: number;
  status: OutboxStatus;
  last_error?: string;
  created_at: string;
  updated_at: string;
}
