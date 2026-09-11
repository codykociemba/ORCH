/**
 * Compound Engineering plan manifest + reuse analysis.
 */

import type { ExistingCodeCandidate } from './modification-contract.js';
import type { ImpactRisk } from './code-intelligence.js';

export type PlanRoute =
  | 'claude_only'
  | 'claude_plus_codex'
  | 'claude_codex_optional_council'
  | 'council_required';

export interface PlanUnit {
  id: string;
  title: string;
  description?: string;
  depends_on: string[];
  acceptance_criteria: string[];
  risk?: ImpactRisk;
  labels?: string[];
}

export interface ReuseAnalysis {
  searches: string[];
  candidates: ExistingCodeCandidate[];
  recommended_edits: Array<{ path: string; symbol?: string; reason: string }>;
  proposed_creates: Array<{
    kind: 'file' | 'symbol' | 'dependency';
    name?: string;
    path?: string;
    package?: string;
    why_not_reuse: string;
    alternatives_considered?: string[];
  }>;
  incomplete: boolean;
  reasons: string[];
}

export interface PlanManifest {
  version: 1;
  id: string;
  goal_id?: string;
  title: string;
  digest: string;
  units: PlanUnit[];
  route: PlanRoute;
  reuse: ReuseAnalysis;
  council_required: boolean;
  council_ref?: string;
  created_at: string;
}

export function routePlan(unitCount: number, highRisk: boolean, requiredTaskCount = 5): PlanRoute {
  if (unitCount >= requiredTaskCount) return 'council_required';
  if (unitCount >= 3) return highRisk ? 'council_required' : 'claude_codex_optional_council';
  if (unitCount >= 1) return 'claude_plus_codex';
  return 'claude_only';
}

export function planDigest(title: string, units: Array<{ title: string }>): string {
  const material = [title, ...units.map((unit) => unit.title)].join('\n');
  let hash = 0;
  for (let i = 0; i < material.length; i++) {
    hash = ((hash << 5) - hash + material.charCodeAt(i)) | 0;
  }
  return `pln_${(hash >>> 0).toString(16)}`;
}
