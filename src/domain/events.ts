/**
 * Orchestrator event system.
 *
 * All communication between layers goes through typed events.
 * The EventBus emits these synchronously; subscribers (TUI, logger,
 * run store, state) react independently.
 */

import type { GoalStatus } from './goal.js';
import type { MessageChannel } from './message.js';
import type { Task, TaskStatus, ReviewResult } from './task.js';

export type OrchestratorEvent =
  | { type: 'task:created'; task: Task }
  | { type: 'task:assigned'; taskId: string; agentId: string }
  | { type: 'task:status_changed'; taskId: string; from: TaskStatus; to: TaskStatus }
  | { type: 'task:auto_reviewed'; taskId: string; passed: boolean; results: ReviewResult[] }
  | { type: 'agent:started'; agentId: string; taskId: string; runId: string }
  | { type: 'agent:output'; runId: string; agentId: string; data: string }
  | { type: 'agent:file_changed'; runId: string; agentId: string; path: string }
  | { type: 'agent:completed'; runId: string; agentId: string; success: boolean }
  | { type: 'agent:error'; runId: string; agentId: string; error: string; errorKind?: import('./errors.js').AdapterErrorKind }
  | { type: 'run:retry'; runId: string; attempt: number; delay_ms: number }
  | { type: 'orchestrator:tick'; running: number; queued: number }
  | { type: 'orchestrator:stall_detected'; runId: string }
  | { type: 'task:scope_overlap'; taskId: string; overlappingTaskId: string; patterns: string[] }
  | { type: 'task:cascade_failed'; taskId: string; failedDependencyId: string; reason: string }
  | { type: 'workspace:merge_succeeded'; taskId: string; branch: string }
  | { type: 'workspace:merge_conflict'; taskId: string; branch: string; conflictInfo: string }
  | { type: 'workspace:conventions_passed'; taskId: string }
  | { type: 'workspace:conventions_failed'; taskId: string; violations: string[] }
  | { type: 'task:orphaned'; taskId: string }
  | { type: 'orchestrator:error'; error: string; context: string; fatal: boolean }
  | { type: 'orchestrator:shutdown'; reason: string }
  | { type: 'message:sent'; messageId: string; fromAgentId: string; toAgentId: string | null; channel: MessageChannel }
  | { type: 'message:delivered'; messageId: string; toAgentId: string; taskId: string }
  | { type: 'team:created'; teamId: string; name: string; leadAgentId: string }
  | { type: 'team:member_joined'; teamId: string; agentId: string }
  | { type: 'team:member_left'; teamId: string; agentId: string }
  | { type: 'team:task_claimed'; teamId: string; taskId: string; agentId: string }
  | { type: 'team:disbanded'; teamId: string }
  | { type: 'team:task_added'; teamId: string; taskId: string }
  | { type: 'agent:autonomous_toggled'; agentId: string; autonomous: boolean }
  | { type: 'goal:created'; goalId: string; title: string }
  | { type: 'goal:status_changed'; goalId: string; from: GoalStatus; to: GoalStatus }
  | { type: 'goal:updated'; goalId: string }
  | { type: 'goal:deleted'; goalId: string }
  | { type: 'code_admission:contract_created'; taskId: string }
  | { type: 'code_admission:request_created'; taskId: string; requestId: string; requestType: string }
  | { type: 'code_admission:request_decided'; taskId: string; requestId: string; approved: boolean }
  | { type: 'code_admission:audit_started'; taskId: string }
  | { type: 'code_admission:audit_completed'; taskId: string; passed: boolean; violations: string[]; deleted_symbols?: string[]; processes?: string[] }
  | { type: 'code_intelligence:index_stale'; taskId?: string; repo: string }
  | { type: 'code_intelligence:index_refreshed'; taskId?: string; repo: string }
  | { type: 'wiki:generated'; branch: string }
  | { type: 'wiki:generation_started'; mode: 'local' | 'preview' | 'canonical'; sha: string }
  | { type: 'wiki:generation_completed'; mode: 'local' | 'preview' | 'canonical'; sha: string; pages: number }
  | { type: 'wiki:publish_started'; provider: 'github' | 'gitlab'; sha: string }
  | { type: 'wiki:publish_blocked'; branch: string; defaultBranch: string }
  | { type: 'wiki:published'; host: string; branch: string; provider?: 'github' | 'gitlab'; sha?: string; url?: string; pages?: number }
  | { type: 'wiki:bootstrap_required'; provider: 'github' }
  | { type: 'wiki:failed'; stage: string; error: string }
  | { type: 'integration:linear_issue_created'; taskId: string; identifier: string }
  | { type: 'integration:linear_issue_updated'; taskId: string; identifier?: string; from?: string; to?: string }
  | { type: 'integration:linear_comment_published'; taskId: string; kind: string }
  | { type: 'integration:github_pr_linked'; taskId: string; url: string; number?: number }
  | { type: 'github:pr_created'; taskId: string; url: string; number?: number }
  | { type: 'github:pr_updated'; taskId: string; url: string; number?: number }
  | { type: 'github:pr_reviewed'; taskId: string; verdict: string; sha: string }
  | { type: 'github:pr_merged'; taskId: string; sha: string }
  | { type: 'integration:proof_published'; taskId: string; headSha: string }
  | { type: 'integration:sync_retry'; provider: string; taskId: string }
  | { type: 'integration:sync_failed'; provider: string; taskId?: string; error: string }
  | { type: 'planning:started'; planId: string; title: string }
  | { type: 'planning:validated'; planId: string; ok: boolean }
  | { type: 'planning:council_started'; planId: string }
  | { type: 'planning:council_member_completed'; planId: string; adapter: string; verdict: string }
  | { type: 'planning:council_completed'; planId: string; councilId: string; verdict: string }
  | { type: 'planning:council_blocked'; planId: string; reason: string }
  | { type: 'planning:council_overridden'; planId: string; reason: string; taskCount: number }
  | { type: 'learning:created'; goalId: string; eligible: boolean }
  | { type: 'learning:refreshed'; goalId?: string };

export type OrchestratorEventType = OrchestratorEvent['type'];

/**
 * Extract event payload by type discriminator.
 */
export type EventPayload<T extends OrchestratorEventType> = Extract<
  OrchestratorEvent,
  { type: T }
>;
