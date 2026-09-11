import { describe, it, expect } from 'vitest';
import { reviewAllowsMerge } from '../../../src/application/review-policy.js';
import type { ReviewEvidence } from '../../../src/domain/evidence.js';

function review(overrides: Partial<ReviewEvidence>): ReviewEvidence {
  return {
    reviewer_type: 'cursor',
    commit_sha: 'abc123',
    verdict: 'approve',
    summary: 'ok',
    timestamp: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('reviewAllowsMerge', () => {
  it('requires an approve on the current SHA', () => {
    expect(reviewAllowsMerge([review({ verdict: 'changes_requested' })], 'human_or_cursor', 'abc123')).toBe(false);
    expect(reviewAllowsMerge([review({})], 'human_or_cursor', 'abc123')).toBe(true);
    expect(reviewAllowsMerge([review({})], 'human_or_cursor', 'other')).toBe(false);
  });

  it('honors human_and_cursor', () => {
    expect(reviewAllowsMerge([review({})], 'human_and_cursor', 'abc123')).toBe(false);
    expect(reviewAllowsMerge([
      review({}),
      review({ reviewer_type: 'human' }),
    ], 'human_and_cursor', 'abc123')).toBe(true);
  });
});
