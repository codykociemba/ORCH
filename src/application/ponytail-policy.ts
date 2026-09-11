/**
 * Ponytail mode routing. Behavioral nudge only — ORCH admission still enforces.
 */

import type { Task } from '../domain/task.js';
import type { WorkflowConfig } from '../domain/workflow-config.js';

export type PonytailMode = 'off' | 'lite' | 'full';
export type PonytailPhase = 'planning' | 'implementation' | 'review';

export interface PonytailDecision {
  mode: PonytailMode;
  reason: string;
}

export function resolvePonytailMode(
  phase: PonytailPhase,
  task: Pick<Task, 'labels' | 'scope' | 'priority'>,
  workflow: WorkflowConfig | null,
): PonytailDecision {
  const cfg = workflow?.ponytail;
  if (cfg?.enabled === false) {
    return { mode: 'off', reason: 'Ponytail disabled in workflow.yml' };
  }

  if (phase === 'planning') {
    return { mode: cfg?.planning ?? 'off', reason: 'planning' };
  }
  if (phase === 'review') {
    return { mode: cfg?.review ?? 'off', reason: 'review' };
  }

  const labels = new Set((task.labels ?? []).map((item) => item.toLowerCase()));
  const highRisk = labels.has('high-risk') || labels.has('high_risk') || (task.priority ?? 3) <= 1;
  if (highRisk) {
    return { mode: cfg?.implementation?.high_risk ?? 'lite', reason: 'high-risk' };
  }

  const bounded = (task.scope ?? []).length > 0 && !labels.has('new-subsystem');
  if (bounded) {
    return { mode: cfg?.implementation?.low_risk_bounded ?? 'full', reason: 'low-risk bounded' };
  }

  return { mode: cfg?.implementation?.default ?? 'lite', reason: 'normal implementation' };
}

export function renderPonytailPrompt(decision: PonytailDecision): string {
  if (decision.mode === 'off') return '';
  const intensity = decision.mode === 'full'
    ? 'Be maximally conservative: reuse existing symbols, add no files unless the contract already allows them.'
    : 'Prefer existing code. Do not invent new files, symbols, or dependencies without `orch admission request`.';
  return [
    '## Ponytail (behavioral — ORCH admission still enforces)',
    `Mode: ${decision.mode} (${decision.reason})`,
    intensity,
    'Does it already exist? Use it. Use stdlib/platform. Avoid speculative abstractions. Fewest files.',
  ].join('\n');
}
