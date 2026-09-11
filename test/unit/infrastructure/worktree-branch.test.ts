import { describe, it, expect } from 'vitest';
import { worktreeBranchName } from '../../../src/infrastructure/workspace/workspace-manager.js';
import { makeTask } from '../application/helpers.js';

describe('worktreeBranchName', () => {
  it('includes the Linear identifier when present', () => {
    const name = worktreeBranchName(makeTask({
      id: 'tsk_abc',
      title: 'Add retry',
      external: { linear: { id: 'x', identifier: 'ENG-142' } },
    }));
    expect(name).toBe('orch/ENG-142-add-retry');
  });
});
