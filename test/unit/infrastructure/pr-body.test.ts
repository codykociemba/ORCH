import { describe, it, expect } from 'vitest';
import { buildPrBody, linearMagicWords } from '../../../src/infrastructure/github/pr-body.js';
import { makeTask } from '../application/helpers.js';

describe('PR body Linear linking', () => {
  it('emits a Linear magic-word and ORCH task/plan refs', () => {
    const task = makeTask({
      id: 'tsk_pr1',
      description: 'Add retry',
      plan_id: 'plan_1',
      plan_unit_id: 'U1',
      external: { linear: { id: 'x', identifier: 'ENG-142' } },
    });
    const body = buildPrBody(task);
    expect(linearMagicWords('ENG-142')).toBe('Fixes ENG-142');
    expect(body).toContain('Fixes ENG-142');
    expect(body).toContain('tsk_pr1');
    expect(body).toContain('U1');
  });
});
