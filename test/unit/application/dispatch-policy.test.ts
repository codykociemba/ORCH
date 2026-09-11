import { describe, it, expect } from 'vitest';
import { passesDispatchGates } from '../../../src/application/dispatch-policy.js';
import { makeTask } from './helpers.js';

describe('passesDispatchGates', () => {
  it('blocks Linear-required tasks without an issue id', () => {
    expect(passesDispatchGates(makeTask(), { linearRequired: true, requirePlan: false })).toBe(false);
    expect(passesDispatchGates(
      makeTask({ external: { linear: { id: 'iss_1', identifier: 'ENG-1' } } }),
      { linearRequired: true, requirePlan: false },
    )).toBe(true);
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
