import { describe, it, expect } from 'vitest';
import { verifySmallPlanReuse } from '../../../src/application/plan-reuse-verifier.js';
import { buildPlanManifest } from '../../../src/application/plan-router.js';
import type { ReuseAnalysis } from '../../../src/domain/plan.js';

const units = [{ id: 'u1', title: 'Retry', depends_on: [], acceptance_criteria: [] }];

describe('verifySmallPlanReuse', () => {
  it('blocks creates when GitNexus was never searched', () => {
    const reuse: ReuseAnalysis = {
      searches: [],
      candidates: [],
      recommended_edits: [],
      proposed_creates: [{ kind: 'symbol', name: 'retry', why_not_reuse: 'guess' }],
      incomplete: false,
      reasons: [],
    };
    const verdict = verifySmallPlanReuse(buildPlanManifest({
      id: 'p1', title: 'Retry', units, reuse,
    }));
    expect(verdict.ok).toBe(false);
    expect(verdict.questions).toHaveLength(4);
  });

  it('blocks creates when the index is incomplete', () => {
    const reuse: ReuseAnalysis = {
      searches: ['retry'],
      candidates: [],
      recommended_edits: [],
      proposed_creates: [{ kind: 'symbol', name: 'retry', why_not_reuse: 'stale' }],
      incomplete: true,
      reasons: ['stale'],
    };
    expect(verifySmallPlanReuse(buildPlanManifest({
      id: 'p1', title: 'Retry', units, reuse,
    })).ok).toBe(false);
  });

  it('asks the four Codex questions for a searched plan', () => {
    const reuse: ReuseAnalysis = {
      searches: ['retry'],
      candidates: [{ path: 'src/retry.ts', relevance: 'high', decision: 'reuse', reason: 'exists' }],
      recommended_edits: [{ path: 'src/retry.ts', symbol: 'retry', reason: 'hit' }],
      proposed_creates: [],
      incomplete: false,
      reasons: [],
    };
    const verdict = verifySmallPlanReuse(buildPlanManifest({
      id: 'p1', title: 'Retry', units, reuse,
    }));
    expect(verdict.ok).toBe(true);
    expect(verdict.notes.join(' ')).toContain('retry');
  });

  it('fail-closes 1–2 unit Codex verify when the adapter is missing', async () => {
    const reuse: ReuseAnalysis = {
      searches: ['retry'],
      candidates: [],
      recommended_edits: [],
      proposed_creates: [],
      incomplete: false,
      reasons: [],
    };
    const { verifySmallPlanWithCodex } = await import('../../../src/application/plan-reuse-verifier.js');
    const verdict = await verifySmallPlanWithCodex(
      buildPlanManifest({ id: 'p1', title: 'Retry', units, reuse }),
      undefined,
      '/repo',
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.notes.join(' ')).toMatch(/Codex is not available/);
  });
});
