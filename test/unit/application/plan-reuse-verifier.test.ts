import { describe, it, expect } from 'vitest';
import { smallPlanImportBlocked, verifySmallPlanReuse } from '../../../src/application/plan-reuse-verifier.js';
import { buildPlanManifest } from '../../../src/application/plan-router.js';
import type { ReuseAnalysis } from '../../../src/domain/plan.js';

const units = [{ id: 'u1', title: 'Retry', depends_on: [], acceptance_criteria: [] }];

describe('smallPlanImportBlocked', () => {
  it('blocks 1–2 unit imports until Codex verify succeeds', () => {
    expect(smallPlanImportBlocked(1, false)).toBe(true);
    expect(smallPlanImportBlocked(2)).toBe(true);
    expect(smallPlanImportBlocked(2, true)).toBe(false);
    expect(smallPlanImportBlocked(3, false)).toBe(false);
    expect(smallPlanImportBlocked(5, false)).toBe(false);
  });
});

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

  it('notes when a hand-edited plan has no GitNexus reuse yet', () => {
    const reuse: ReuseAnalysis = {
      searches: [],
      candidates: [],
      recommended_edits: [],
      proposed_creates: [],
      incomplete: false,
      reasons: [],
    };
    const verdict = verifySmallPlanReuse(buildPlanManifest({
      id: 'p1', title: 'Retry', units, reuse,
    }));
    expect(verdict.ok).toBe(true);
    expect(verdict.notes.join(' ')).toContain('orch plan reuse');
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

  it('notes HIGH/CRITICAL impact is not automatic reuse', () => {
    const reuse: ReuseAnalysis = {
      searches: ['retry'],
      candidates: [{
        path: 'src/retry.ts',
        symbol: 'retry',
        relevance: 'high',
        decision: 'investigate',
        reason: 'GitNexus hit (impact HIGH, 4 dependents, processes: RetryFlow)',
      }],
      recommended_edits: [],
      proposed_creates: [],
      incomplete: false,
      reasons: [],
    };
    const verdict = verifySmallPlanReuse(buildPlanManifest({
      id: 'p1', title: 'Retry', units, reuse,
    }));
    expect(verdict.ok).toBe(true);
    expect(verdict.notes.join(' ')).toContain('HIGH/CRITICAL/UNKNOWN impact is not automatic reuse');
    expect(verdict.notes.join(' ')).toContain('retry');
  });

  it('fail-closes when HIGH impact is still listed as a recommended edit', () => {
    const reuse: ReuseAnalysis = {
      searches: ['retry'],
      candidates: [{
        path: 'src/retry.ts',
        symbol: 'retry',
        relevance: 'high',
        decision: 'investigate',
        reason: 'GitNexus hit (impact HIGH, 4 dependents, processes: RetryFlow)',
      }],
      recommended_edits: [{ path: 'src/retry.ts', symbol: 'retry', reason: 'hit' }],
      proposed_creates: [],
      incomplete: false,
      reasons: [],
    };
    const verdict = verifySmallPlanReuse(buildPlanManifest({
      id: 'p1', title: 'Retry', units, reuse,
    }));
    expect(verdict.ok).toBe(false);
    expect(verdict.notes.join(' ')).toContain('recommended_edits');
  });

  it('fail-closes UNKNOWN impact', () => {
    const reuse: ReuseAnalysis = {
      searches: ['retry'],
      candidates: [{
        path: 'src/retry.ts',
        symbol: 'retry',
        relevance: 'high',
        decision: 'investigate',
        reason: 'GitNexus hit (impact UNKNOWN, 0 dependents, processes: none)',
      }],
      recommended_edits: [],
      proposed_creates: [],
      incomplete: false,
      reasons: [],
    };
    const verdict = verifySmallPlanReuse(buildPlanManifest({
      id: 'p1', title: 'Retry', units, reuse,
    }));
    expect(verdict.ok).toBe(false);
    expect(verdict.notes.join(' ')).toContain('UNKNOWN impact is not LOW');
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

  it('sends GitNexus impact and create alternatives to Codex', async () => {
    let prompt = '';
    const { verifySmallPlanWithCodex } = await import('../../../src/application/plan-reuse-verifier.js');
    const adapter = {
      kind: 'codex',
      test: async () => ({ ok: true }),
      execute: (params: { prompt: string }) => {
        prompt = params.prompt;
        return {
          pid: 1,
          events: (async function* () {
            yield { type: 'done' as const, timestamp: 't', data: { text: '{"status":"approved","reason":"reuse retry"}' } };
          })(),
        };
      },
      stop: async () => {},
    };
    const reuse: ReuseAnalysis = {
      searches: ['retry'],
      candidates: [
        {
          path: 'src/retry.ts',
          symbol: 'retry',
          relevance: 'high',
          decision: 'investigate',
          reason: 'GitNexus hit (impact HIGH, 4 dependents, processes: RetryFlow)',
        },
        {
          path: 'process',
          symbol: 'RetryFlow',
          kind: 'process',
          relevance: 'medium',
          decision: 'investigate',
          reason: 'process',
        },
      ],
      recommended_edits: [],
      proposed_creates: [{
        kind: 'file',
        path: 'src/retry-audit.ts',
        why_not_reuse: 'no existing audit sink',
        alternatives_considered: ['src/retry.ts'],
      }],
      incomplete: false,
      reasons: [],
    };
    const verdict = await verifySmallPlanWithCodex(
      buildPlanManifest({ id: 'p1', title: 'Retry', units, reuse }),
      adapter,
      '/repo',
    );
    expect(verdict.ok).toBe(false);
    expect(prompt).toContain('Impact:');
    expect(prompt).toContain('impact HIGH');
    expect(prompt).toContain('RetryFlow');
    expect(prompt).toContain('alts=src/retry.ts');
    expect(prompt).toContain('HIGH/CRITICAL/UNKNOWN impact is not automatic reuse');
  });
});
