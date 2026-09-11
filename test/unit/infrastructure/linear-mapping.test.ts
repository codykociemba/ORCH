import { describe, it, expect } from 'vitest';
import { LINEAR_STATE_FOR_TASK } from '../../../src/infrastructure/integrations/linear/linear-issue-tracker.js';

describe('Linear status mapping', () => {
  it('maps ORCH statuses onto Linear state names', () => {
    expect(LINEAR_STATE_FOR_TASK.todo).toContain('todo');
    expect(LINEAR_STATE_FOR_TASK.in_progress).toContain('in progress');
    expect(LINEAR_STATE_FOR_TASK.review).toContain('in review');
    expect(LINEAR_STATE_FOR_TASK.done).toContain('done');
    expect(LINEAR_STATE_FOR_TASK.failed).toContain('canceled');
  });
});
