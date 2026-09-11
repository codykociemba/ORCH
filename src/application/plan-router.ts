/**
 * Route a CE plan to Claude / Codex / Council based on unit count and risk.
 */

import { planDigest, routePlan, type PlanManifest, type PlanUnit } from '../domain/plan.js';
import type { ReuseAnalysis } from '../domain/plan.js';
import type { WorkflowConfig } from '../domain/workflow-config.js';

export function buildPlanManifest(input: {
  id: string;
  title: string;
  goalId?: string;
  units: PlanUnit[];
  reuse: ReuseAnalysis;
  workflow?: WorkflowConfig | null;
}): PlanManifest {
  const highRisk = input.units.some((unit) => unit.risk === 'high' || unit.risk === 'critical' || unit.risk === 'unknown');
  const required = input.workflow?.council?.required_task_count ?? 5;
  const route = routePlan(input.units.length, highRisk, required);
  return {
    version: 1,
    id: input.id,
    goal_id: input.goalId,
    title: input.title,
    digest: planDigest(input.title, input.units),
    units: input.units,
    route,
    reuse: input.reuse,
    council_required: route === 'council_required',
    created_at: new Date().toISOString(),
  };
}

export function draftUnitsFromRequest(title: string, extraUnitTitles: string[] = []): PlanUnit[] {
  const titles = extraUnitTitles.length > 0 ? extraUnitTitles : [title];
  return titles.map((unitTitle, index) => ({
    id: `u${index + 1}`,
    title: unitTitle,
    description: unitTitle,
    depends_on: index === 0 ? [] : [`u${index}`],
    acceptance_criteria: [],
  }));
}

export function describeRoute(manifest: PlanManifest): string {
  switch (manifest.route) {
    case 'council_required':
      return 'Council required (Claude + Codex + Cursor Grok). Independent repo inspection.';
    case 'claude_codex_optional_council':
      return 'Claude plans, Codex verifies, Council only if high-risk or uncertain.';
    case 'claude_plus_codex':
      return 'Claude plans, Codex / medium verifies.';
    default:
      return 'Claude plans.';
  }
}
