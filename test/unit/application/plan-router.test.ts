import { describe, it, expect } from 'vitest';
import { buildPlanManifest, draftUnitsFromRequest } from '../../../src/application/plan-router.js';
import { routePlan } from '../../../src/domain/plan.js';
import type { ReuseAnalysis } from '../../../src/domain/plan.js';

const reuse: ReuseAnalysis = {
  searches: ['retry'],
  candidates: [],
  recommended_edits: [],
  proposed_creates: [],
  incomplete: false,
  reasons: [],
};

describe('plan router', () => {
  it('routes 1-2 units to Claude + Codex', () => {
    expect(routePlan(2, false)).toBe('claude_plus_codex');
  });

  it('routes 3-4 units without high risk to optional council', () => {
    expect(routePlan(3, false)).toBe('claude_codex_optional_council');
  });

  it('requires council at 5+ units', () => {
    expect(routePlan(5, false)).toBe('council_required');
  });

  it('requires council for 3-unit high-risk plans', () => {
    expect(routePlan(3, true)).toBe('council_required');
  });

  it('builds a digest and council flag', () => {
    const manifest = buildPlanManifest({
      id: 'plan_1',
      title: 'Retry',
      units: [
        { id: 'u1', title: 'A', depends_on: [], acceptance_criteria: [] },
        { id: 'u2', title: 'B', depends_on: [], acceptance_criteria: [] },
        { id: 'u3', title: 'C', depends_on: [], acceptance_criteria: [], risk: 'critical' },
      ],
      reuse,
    });
    expect(manifest.council_required).toBe(true);
    expect(manifest.digest.startsWith('pln_')).toBe(true);
  });

  it('drafts one unit from a request, or a chain from --unit titles', () => {
    expect(draftUnitsFromRequest('Add retry').map((unit) => unit.id)).toEqual(['u1']);
    const chained = draftUnitsFromRequest('Goal', ['Search', 'Audit', 'Proof']);
    expect(chained.map((unit) => unit.id)).toEqual(['u1', 'u2', 'u3']);
    expect(chained[2]?.depends_on).toEqual(['u2']);
  });
});
