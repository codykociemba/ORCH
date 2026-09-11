/**
 * Structured logger for `orch serve`.
 *
 * Transforms OrchestratorEvents into flat ServeEvent records
 * and writes them as JSON or human-readable text lines to one
 * or more output streams (stdout, log file).
 */

import type { OrchestratorEvent } from '../../domain/events.js';
import type { EventBus } from '../../application/event-bus.js';
import type { ServeLoggerOptions, ServeEvent, LogLevel } from './types.js';

export class StructuredLogger {
  private tickCounter = 0;
  private readonly opts: ServeLoggerOptions;

  constructor(opts: ServeLoggerOptions) {
    this.opts = opts;
  }

  /**
   * Subscribe to all events on the bus.
   * Returns an unsubscribe function.
   */
  subscribe(eventBus: EventBus): () => void {
    return eventBus.onAny((event) => {
      const entry = this.transform(event);
      if (entry) this.write(entry);
    });
  }

  /**
   * Write a standalone log entry (e.g. serve:started, idle).
   */
  log(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
    this.write({
      ts: new Date().toISOString(),
      level,
      event,
      ...fields,
    });
  }

  /**
   * Close non-stdout streams (file handles).
   */
  async flush(): Promise<void> {
    const closes = this.opts.streams
      .filter((s) => s !== process.stdout && s !== process.stderr)
      .map((s) => new Promise<void>((resolve) => {
        s.end(() => { resolve(); });
      }));
    await Promise.all(closes);
  }

  /**
   * Transform an OrchestratorEvent into a flat ServeEvent.
   * Returns null for events that should be suppressed.
   */
  private transform(event: OrchestratorEvent): ServeEvent | null {
    const ts = new Date().toISOString();

    switch (event.type) {
      case 'orchestrator:tick': {
        this.tickCounter++;
        const isIdle = event.running === 0 && event.queued === 0;
        // In non-verbose mode, only log every Nth idle tick
        if (!this.opts.verbose && isIdle && this.tickCounter % this.opts.idleLogInterval !== 0) {
          return null;
        }
        const heap_mb = +(process.memoryUsage().heapUsed / 1_048_576).toFixed(1);
        return { ts, level: 'info', event: event.type, running: event.running, queued: event.queued, heap_mb };
      }

      case 'orchestrator:shutdown':
        return { ts, level: 'info', event: event.type, reason: event.reason };

      case 'orchestrator:error':
        return {
          ts,
          level: event.fatal ? 'error' : 'warn',
          event: event.type,
          error: event.error,
          context: event.context,
          fatal: event.fatal,
        };

      case 'orchestrator:stall_detected':
        return { ts, level: 'warn', event: event.type, runId: event.runId };

      case 'agent:started':
        return { ts, level: 'info', event: event.type, agentId: event.agentId, taskId: event.taskId, runId: event.runId };

      case 'agent:completed':
        return { ts, level: event.success ? 'info' : 'warn', event: event.type, runId: event.runId, agentId: event.agentId, success: event.success };

      case 'agent:error':
        return { ts, level: 'error', event: event.type, runId: event.runId, agentId: event.agentId, error: event.error, errorKind: event.errorKind };

      case 'agent:output':
        if (!this.opts.verbose) return null;
        return { ts, level: 'debug', event: event.type, runId: event.runId, agentId: event.agentId, data: event.data.slice(0, 200) };

      case 'agent:file_changed':
        return { ts, level: 'info', event: event.type, runId: event.runId, agentId: event.agentId, path: event.path };

      case 'run:retry':
        return { ts, level: 'warn', event: event.type, runId: event.runId, attempt: event.attempt, delay_ms: event.delay_ms };

      case 'task:created':
        return { ts, level: 'info', event: event.type, taskId: event.task.id, title: event.task.title };

      case 'task:status_changed':
        return { ts, level: 'info', event: event.type, taskId: event.taskId, from: event.from, to: event.to };

      case 'task:auto_reviewed':
        return { ts, level: 'info', event: event.type, taskId: event.taskId, passed: event.passed };

      case 'workspace:merge_succeeded':
        return { ts, level: 'info', event: event.type, taskId: event.taskId, branch: event.branch };

      case 'workspace:merge_conflict':
        return { ts, level: 'warn', event: event.type, taskId: event.taskId, branch: event.branch, conflictInfo: event.conflictInfo };

      case 'task:orphaned':
        return { ts, level: 'warn', event: event.type, taskId: event.taskId };

      case 'task:scope_overlap':
        return { ts, level: 'warn', event: event.type, taskId: event.taskId, overlappingTaskId: event.overlappingTaskId, patterns: event.patterns };

      case 'task:cascade_failed':
        return { ts, level: 'warn', event: event.type, taskId: event.taskId, failedDependencyId: event.failedDependencyId, reason: event.reason };

      case 'integration:linear_issue_created':
        return { ts, level: 'info', event: event.type, taskId: event.taskId, identifier: event.identifier };

      case 'integration:linear_issue_updated':
        return { ts, level: 'info', event: event.type, taskId: event.taskId, identifier: event.identifier, from: event.from, to: event.to };

      case 'integration:linear_comment_published':
        return { ts, level: 'info', event: event.type, taskId: event.taskId, kind: event.kind };

      case 'integration:github_pr_linked':
        return { ts, level: 'info', event: event.type, taskId: event.taskId, url: event.url, number: event.number };

      case 'github:pr_created':
      case 'github:pr_updated':
        return { ts, level: 'info', event: event.type, taskId: event.taskId, url: event.url, number: event.number };

      case 'github:pr_reviewed':
        return { ts, level: 'info', event: event.type, taskId: event.taskId, verdict: event.verdict, sha: event.sha };

      case 'github:pr_merged':
        return { ts, level: 'info', event: event.type, taskId: event.taskId, sha: event.sha };

      case 'integration:proof_published':
        return { ts, level: 'info', event: event.type, taskId: event.taskId, headSha: event.headSha };

      case 'integration:sync_retry':
        return { ts, level: 'warn', event: event.type, provider: event.provider, taskId: event.taskId };

      case 'integration:sync_failed':
        return { ts, level: 'error', event: event.type, provider: event.provider, taskId: event.taskId, error: event.error };

      case 'planning:started':
        return { ts, level: 'info', event: event.type, planId: event.planId, title: event.title };

      case 'planning:validated':
        return { ts, level: event.ok ? 'info' : 'warn', event: event.type, planId: event.planId, ok: event.ok };

      case 'planning:council_started':
        return { ts, level: 'info', event: event.type, planId: event.planId };

      case 'planning:council_member_completed':
        return { ts, level: 'info', event: event.type, planId: event.planId, adapter: event.adapter, verdict: event.verdict };

      case 'planning:council_completed':
        return { ts, level: 'info', event: event.type, planId: event.planId, councilId: event.councilId, verdict: event.verdict };

      case 'planning:council_blocked':
        return { ts, level: 'warn', event: event.type, planId: event.planId, reason: event.reason };

      case 'planning:council_overridden':
        return { ts, level: 'warn', event: event.type, planId: event.planId, reason: event.reason, taskCount: event.taskCount };

      case 'learning:created':
        return { ts, level: 'info', event: event.type, goalId: event.goalId, eligible: event.eligible };

      case 'learning:refreshed':
        return { ts, level: 'info', event: event.type, goalId: event.goalId };

      case 'code_admission:contract_created':
        return { ts, level: 'info', event: event.type, taskId: event.taskId };

      case 'code_admission:audit_started':
        return { ts, level: 'info', event: event.type, taskId: event.taskId };

      case 'code_admission:request_created':
        return { ts, level: 'info', event: event.type, taskId: event.taskId, requestId: event.requestId, requestType: event.requestType };

      case 'code_admission:request_decided':
        return { ts, level: event.approved ? 'info' : 'warn', event: event.type, taskId: event.taskId, requestId: event.requestId, approved: event.approved };

      case 'code_admission:audit_completed':
        return {
          ts,
          level: event.passed ? 'info' : 'warn',
          event: event.type,
          taskId: event.taskId,
          passed: event.passed,
          violations: event.violations,
          deleted_symbols: event.deleted_symbols,
          processes: event.processes,
        };

      case 'workspace:conventions_passed':
        return { ts, level: 'info', event: event.type, taskId: event.taskId };

      case 'workspace:conventions_failed':
        return { ts, level: 'warn', event: event.type, taskId: event.taskId, violations: event.violations };

      case 'code_intelligence:index_stale':
        return { ts, level: 'warn', event: event.type, repo: event.repo, taskId: event.taskId };

      case 'code_intelligence:index_refreshed':
        return { ts, level: 'info', event: event.type, repo: event.repo, taskId: event.taskId };

      case 'wiki:generation_started':
        return { ts, level: 'info', event: event.type, mode: event.mode, sha: event.sha };

      case 'wiki:generation_completed':
        return { ts, level: 'info', event: event.type, mode: event.mode, sha: event.sha, pages: event.pages };

      case 'wiki:publish_started':
        return { ts, level: 'info', event: event.type, provider: event.provider, sha: event.sha };

      case 'wiki:publish_blocked':
        return { ts, level: 'warn', event: event.type, branch: event.branch, defaultBranch: event.defaultBranch };

      case 'wiki:published':
        return { ts, level: 'info', event: event.type, host: event.host, branch: event.branch, pages: event.pages };

      case 'wiki:bootstrap_required':
        return { ts, level: 'warn', event: event.type, provider: event.provider };

      case 'wiki:failed':
        return { ts, level: 'error', event: event.type, stage: event.stage, error: event.error };

      default:
        return null;
    }
  }

  private write(entry: ServeEvent): void {
    const line = this.opts.format === 'json'
      ? JSON.stringify(entry) + '\n'
      : this.formatText(entry);

    for (const stream of this.opts.streams) {
      stream.write(line);
    }
  }

  private formatText(entry: ServeEvent): string {
    const time = entry.ts.slice(11, 23); // HH:MM:SS.mmm
    const level = entry.level.toUpperCase().padEnd(5);
    const { ts: _ts, level: _level, event, ...rest } = entry;

    const fields = Object.entries(rest)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');

    return `${time} ${level} ${event}  ${fields}\n`;
  }
}
