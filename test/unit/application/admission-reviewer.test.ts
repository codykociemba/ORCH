import { describe, it, expect } from 'vitest';
import { HeuristicAdmissionReviewer, parseAdmissionDecision, pickReviewerKind } from '../../../src/application/admission-reviewer.js';
import type { AdmissionRequest } from '../../../src/domain/admission.js';

const request = (type: AdmissionRequest['type']): AdmissionRequest => ({
  id: 'adm_1',
  task_id: 'tsk_1',
  type,
  requested_at: '2026-01-01T00:00:00Z',
  proposed: { path: 'src/x.ts', name: 'foo' },
  status: 'pending_llm',
});

describe('admission reviewer policy', () => {
  const reviewer = new HeuristicAdmissionReviewer();

  it('routes high impact to Codex and council creates to Council', () => {
    expect(pickReviewerKind({ impact: 'high', councilApprovedPlan: false, type: 'new_file' })).toBe('codex');
    expect(pickReviewerKind({ impact: 'low', councilApprovedPlan: true, type: 'new_file' })).toBe('council');
    expect(pickReviewerKind({ impact: 'low', councilApprovedPlan: false, type: 'new_symbol' })).toBe('claude');
  });

  it('auto-approves low-risk existing-symbol edits only', async () => {
    const decision = await reviewer.review({
      request: request('high_risk_edit'),
      hits: [],
      impact: 'low',
      kind: 'claude',
      councilApprovedPlan: false,
    });
    expect(decision.status).toBe('approved');
  });

  it('does not self-approve a new file', async () => {
    const decision = await reviewer.review({
      request: request('new_file'),
      hits: [],
      kind: 'claude',
      councilApprovedPlan: false,
    });
    expect(decision.status).toBe('defer');
  });

  it('parses adapter JSON decisions and ignores non-JSON', () => {
    expect(parseAdmissionDecision('noise {"status":"rejected","reason":"reuse Foo"}', 'claude')).toEqual({
      status: 'rejected',
      reason: 'reuse Foo',
      reviewer_model: 'claude',
    });
    expect(parseAdmissionDecision('sorry I cannot', 'claude')).toBeNull();
  });
});
