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
    expect(linearMagicWords('ENG-142', 'contributes')).toBe('Contributes to ENG-142');
    expect(body).toContain('Contributes to ENG-142');
    expect(body).not.toContain('Fixes ENG-142');
    expect(body).toContain('## Summary');
    expect(body).toContain('## Linear');
    expect(body).toContain('## ORCH');
    expect(body).toContain('## Verification');
    expect(body).toContain('tsk_pr1');
    expect(body).not.toContain('Agent:');
    expect(body).toContain('U1');
    expect(buildPrBody(makeTask({
      id: 'tsk_pr1',
      assignee: 'agt_claude',
      plan_id: 'plan_1',
      plan_unit_id: 'U1',
      external: { linear: { id: 'x', identifier: 'ENG-142' } },
    }))).toContain('Agent: `agt_claude`');
    expect(body).toContain('<!-- orch-proof:tsk_pr1:HEADSHA -->');
  });

  it('uses Fixes when a plan unit is the last open unit for the issue', () => {
    const task = makeTask({
      id: 'tsk_last',
      plan_id: 'plan_1',
      plan_unit_id: 'U3',
      external: { linear: { id: 'x', identifier: 'ENG-142' } },
    });
    expect(buildPrBody(task, { completesIssue: true })).toContain('Fixes ENG-142');
    expect(buildPrBody(task, { completesIssue: true })).not.toContain('Contributes to ENG-142');
  });

  it('uses Fixes when the task is a standalone issue, not a plan unit', () => {
    const task = makeTask({
      id: 'tsk_solo',
      title: 'Add authentication refresh flow',
      external: { linear: { id: 'x', identifier: 'ENG-123' } },
    });
    expect(buildPrBody(task)).toContain('Fixes ENG-123');
  });

  it('binds the proof marker to the task HEAD SHA when proof is present', () => {
    const task = makeTask({
      id: 'tsk_sha',
      external: { linear: { id: 'x', identifier: 'ENG-123' } },
      proof: { files_changed: [], head_sha: 'abcdef1234567890' },
    });
    expect(buildPrBody(task)).toContain('<!-- orch-proof:tsk_sha:abcdef1234567890 -->');
    expect(buildPrBody(task)).not.toContain('HEADSHA');
  });

  it('joins multiple completing Linear issues on one Fixes line', () => {
    expect(linearMagicWords(['ENG-123', 'ENG-124'])).toBe('Fixes ENG-123, ENG-124');
    expect(linearMagicWords(['ENG-123', 'ENG-124'], 'contributes')).toBe('Contributes to ENG-123, ENG-124');
  });

  it('lists sibling plan-unit issues without closing them', () => {
    const task = makeTask({
      id: 'tsk_u3',
      plan_id: 'plan_1',
      plan_unit_id: 'U-03',
      external: {
        linear: {
          id: 'iss_123',
          identifier: 'ENG-123',
          url: 'https://linear.app/konci/issue/ENG-123',
        },
      },
    });
    const body = buildPrBody(task, {
      completesIssue: true,
      relatedIssues: [
        {
          identifier: 'ENG-124',
          url: 'https://linear.app/konci/issue/ENG-124',
          completes: false,
        },
      ],
    });
    expect(body).toContain('Fixes ENG-123');
    expect(body).toContain('Contributes to ENG-124');
    expect(body).not.toContain('Fixes ENG-123, ENG-124');
    expect(body).toContain('Linear issue: https://linear.app/konci/issue/ENG-123');
    expect(body).toContain('Linear issue: https://linear.app/konci/issue/ENG-124');
  });

  it('emits Fixes for every issue a PR intentionally completes', () => {
    const task = makeTask({
      id: 'tsk_multi',
      external: { linear: { id: 'iss_123', identifier: 'ENG-123' } },
    });
    const body = buildPrBody(task, {
      relatedIssues: [{ identifier: 'ENG-124', completes: true }],
    });
    expect(body).toContain('Fixes ENG-123, ENG-124');
    expect(body).not.toContain('Contributes to');
  });
});
