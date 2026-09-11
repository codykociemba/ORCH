import { describe, it, expect } from 'vitest';
import {
  AdapterAdmissionReviewer,
  HeuristicAdmissionReviewer,
  parseAdmissionDecision,
  pickReviewerKind,
} from '../../../src/application/admission-reviewer.js';
import type { AdmissionRequest } from '../../../src/domain/admission.js';
import type { IAgentAdapter } from '../../../src/infrastructure/adapters/interface.js';

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

  it('does not auto-approve HIGH or CRITICAL existing-symbol edits', async () => {
    const high = await reviewer.review({
      request: request('high_risk_edit'),
      hits: [],
      impact: 'high',
      kind: 'codex',
      councilApprovedPlan: false,
    });
    expect(high.status).toBe('defer');
    const critical = await reviewer.review({
      request: request('high_risk_edit'),
      hits: [],
      impact: 'critical',
      kind: 'codex',
      councilApprovedPlan: false,
    });
    expect(critical.status).toBe('defer');
  });

  it('does not treat unspecified impact as LOW for existing-symbol edits', async () => {
    const decision = await reviewer.review({
      request: request('high_risk_edit'),
      hits: [],
      kind: 'claude',
      councilApprovedPlan: false,
    });
    expect(decision.status).toBe('rejected');
    expect(decision.reason).toMatch(/UNKNOWN/i);
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
    const empty = await reviewer.review({
      request: request('new_file'),
      hits: [],
      kind: 'claude',
      councilApprovedPlan: false,
    });
    expect(empty.status).toBe('rejected');
    expect(empty.reason).toMatch(/cleaner/i);
    const cleaner = await reviewer.review({
      request: { ...request('new_file'), why_existing_file_is_not_enough: 'Cleaner.' },
      hits: [],
      kind: 'claude',
      councilApprovedPlan: false,
    });
    expect(cleaner.status).toBe('rejected');
    const reasoned = await reviewer.review({
      request: {
        ...request('new_file'),
        why_existing_file_is_not_enough: 'CustomerService owns cancel; this is a new billing boundary.',
      },
      hits: [],
      kind: 'claude',
      councilApprovedPlan: false,
    });
    expect(reasoned.status).toBe('defer');
    const dependency = await reviewer.review({
      request: { ...request('new_dependency'), proposed: { package: 'left-pad' }, need: 'nicer' },
      hits: [],
      kind: 'claude',
      councilApprovedPlan: false,
    });
    expect(dependency.status).toBe('rejected');
    expect(dependency.reason).toMatch(/stdlib/i);
    const emptySymbol = await reviewer.review({
      request: request('new_symbol'),
      hits: [],
      kind: 'claude',
      councilApprovedPlan: false,
    });
    expect(emptySymbol.status).toBe('rejected');
    expect(emptySymbol.reason).toMatch(/symbol/i);
    const councilSymbol = await reviewer.review({
      request: {
        ...request('new_symbol'),
        why_existing_file_is_not_enough: 'CustomerService owns cancel; this is a new billing boundary.',
      },
      hits: [],
      kind: 'council',
      councilApprovedPlan: true,
    });
    expect(councilSymbol.status).toBe('defer');
    expect(councilSymbol.reason).toMatch(/Council/i);
    const emptyScope = await reviewer.review({
      request: request('scope_expansion'),
      hits: [],
      kind: 'claude',
      councilApprovedPlan: false,
    });
    expect(emptyScope.status).toBe('rejected');
    expect(emptyScope.reason).toMatch(/Scope expansion/i);
    const councilScope = await reviewer.review({
      request: {
        ...request('scope_expansion'),
        why_existing_file_is_not_enough: 'CustomerService owns cancel; this is a new billing boundary.',
      },
      hits: [],
      kind: 'council',
      councilApprovedPlan: true,
    });
    expect(councilScope.status).toBe('defer');
    expect(councilScope.reason).toMatch(/Council/i);
  });

  it('sends GitNexus candidates and impact rules to the watcher adapter', async () => {
    let prompt = '';
    let effort: string | undefined;
    const adapter: IAgentAdapter = {
      kind: 'codex',
      test: async () => ({ ok: true }),
      execute: (params) => {
        prompt = params.prompt;
        effort = params.config.effort;
        return {
          pid: 1,
          events: (async function* () {
            yield {
              type: 'done',
              timestamp: '2026-01-01T00:00:00Z',
              data: { result: '{"status":"rejected","reason":"reuse foo"}' },
            };
          })(),
        };
      },
      stop: async () => {},
    };
    const watcher = new AdapterAdmissionReviewer(() => adapter, '/repo');
    const decision = await watcher.review({
      request: {
        ...request('new_file'),
        why_existing_file_is_not_enough: 'different shape',
        existing_candidates: [{ path: 'src/x.ts', symbol: 'foo', why_not_reuse: 'different shape' }],
      },
      hits: [{ path: 'src/x.ts', symbol: 'foo' }],
      impact: 'medium',
      kind: 'codex',
      councilApprovedPlan: false,
    });
    expect(decision.status).toBe('rejected');
    expect(prompt).toContain('src/x.ts');
    expect(prompt).toContain('different shape');
    expect(prompt).toMatch(/UNKNOWN or unspecified impact is not LOW/);
    expect(prompt).toMatch(/HIGH\/CRITICAL impact is not automatic/);
    expect(prompt).toMatch(/Reject "cleaner"/);
    expect(prompt).toMatch(/stdlib\/platform/);
    expect(prompt).toMatch(/new symbol/);
    expect(prompt).toMatch(/scope expansion/);
    expect(effort).toBe('medium');
  });

  it('parses adapter JSON decisions and ignores non-JSON', () => {
    expect(parseAdmissionDecision('noise {"status":"rejected","reason":"reuse Foo"}', 'claude')).toEqual({
      status: 'rejected',
      reason: 'reuse Foo',
      reviewer_model: 'claude',
    });
    expect(parseAdmissionDecision('sorry I cannot', 'claude')).toBeNull();
  });

  it('reads a nested verdict inside a stream-json envelope and accepts approve aliases', () => {
    const envelope = JSON.stringify({
      type: 'result',
      usage: { status: 'ok' },
      result: 'notes first {"verdict":"approve","reason":"reuse existing tracker"}',
    });
    expect(parseAdmissionDecision(envelope, 'cursor')).toEqual({
      status: 'approved',
      reason: 'reuse existing tracker',
      reviewer_model: 'cursor',
    });
  });
});
