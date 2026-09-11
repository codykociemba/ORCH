import { describe, it, expect } from 'vitest';
import { passesDispatchGates } from '../../../src/application/dispatch-policy.js';
import { COUNCIL_OVERRIDE_LABEL, councilVerdictAllowsDispatch, renderCouncilMarkdown } from '../../../src/domain/council.js';
import { makeTask } from './helpers.js';

describe('passesDispatchGates', () => {
  it('blocks Linear-required tasks without an issue id', () => {
    expect(passesDispatchGates(makeTask(), { linearRequired: true, requirePlan: false })).toBe(false);
    expect(passesDispatchGates(
      makeTask({ external: { linear: { id: 'iss_1', identifier: 'ENG-1' } } }),
      { linearRequired: true, requirePlan: false },
    )).toBe(true);
  });

  it('only an approve council verdict may unlock dispatch', () => {
    expect(councilVerdictAllowsDispatch('approve')).toBe(true);
    expect(councilVerdictAllowsDispatch('revise')).toBe(false);
    expect(councilVerdictAllowsDispatch('reject')).toBe(false);
  });

  it('renders a council markdown report with member votes', () => {
    const markdown = renderCouncilMarkdown({
      id: 'cnc_1',
      plan_id: 'plan_1',
      created_at: '2026-01-01T00:00:00Z',
      rounds: 1,
      votes: [{
        model: 'claude',
        adapter: 'claude',
        verdict: 'approve',
        summary: 'reuse',
        requested_model: 'claude',
        actual_model: 'cli-default',
        fallback: 'cli-default',
      }],
      verdict: 'approve',
      summary: 'ok',
      gitnexus_evidence: { searches: ['retry'], candidates: ['src/a.ts'], incomplete: false },
    });
    expect(markdown).toContain('**approve**');
    expect(markdown).toContain('claude / claude');
    expect(markdown).toContain('Fallback: cli-default');
    expect(markdown).toContain('may dispatch');
    expect(markdown).toContain('## Human override');
    expect(markdown).toContain('none recorded');
  });

  it('records a human override without rewriting the verdict', () => {
    const markdown = renderCouncilMarkdown({
      id: 'cnc_2',
      plan_id: 'plan_2',
      plan_digest: 'pln_2',
      created_at: '2026-01-01T00:00:00Z',
      rounds: 1,
      votes: [{ model: 'claude', adapter: 'claude', verdict: 'revise', summary: 'member missing' }],
      verdict: 'revise',
      summary: 'blocked',
      human_override: {
        reason: 'CLI outage',
        at: '2026-01-02T00:00:00Z',
        actor: 'human',
        task_ids: ['tsk_1'],
      },
    });
    expect(markdown).toContain('**revise**');
    expect(markdown).toContain('CLI outage');
    expect(markdown).toContain('Does not fabricate an approve');
    expect(markdown).not.toContain('may dispatch');
  });

  it('blocks council-required tasks without a council_ref', () => {
    expect(passesDispatchGates(
      makeTask({ labels: ['council-required'] }),
      { linearRequired: false, requirePlan: false },
    )).toBe(false);
    expect(passesDispatchGates(
      makeTask({ labels: ['council-required'], council_ref: 'cnc_1' }),
      { linearRequired: false, requirePlan: false },
    )).toBe(true);
    expect(passesDispatchGates(
      makeTask({ labels: ['council-required', COUNCIL_OVERRIDE_LABEL] }),
      { linearRequired: false, requirePlan: false },
    )).toBe(true);
  });

  it('blocks goal-linked tasks when a plan is required and missing', () => {
    expect(passesDispatchGates(
      makeTask({ goalId: 'goal_1' }),
      { linearRequired: false, requirePlan: true },
    )).toBe(false);
    expect(passesDispatchGates(
      makeTask({ goalId: 'goal_1', plan_id: 'plan_1' }),
      { linearRequired: false, requirePlan: true },
    )).toBe(true);
  });
});
