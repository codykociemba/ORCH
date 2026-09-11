import { describe, it, expect } from 'vitest';
import { resolveReviewPolicy, reviewAllowsMerge } from '../../../src/application/review-policy.js';
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

  it('uses high_risk_policy when the task is labeled high-risk', () => {
    expect(resolveReviewPolicy({ labels: ['feature'] }, { policy: 'human_or_cursor' })).toBe('human_or_cursor');
    expect(resolveReviewPolicy(
      { labels: ['council-required'] },
      { policy: 'human_or_cursor', high_risk_policy: 'human_and_cursor' },
    )).toBe('human_and_cursor');
    expect(resolveReviewPolicy(
      { labels: ['critical'] },
      { policy: 'human_or_cursor', high_risk_policy: 'human_and_cursor' },
    )).toBe('human_and_cursor');
    expect(resolveReviewPolicy(
      { labels: ['feature'] },
      { policy: 'human_or_cursor', high_risk_policy: 'human_and_cursor' },
      {
        existing_code_considered: [{
          reason: 'GitNexus hit for "build" (impact CRITICAL, 7 dependents, processes: none)',
        }],
      },
    )).toBe('human_and_cursor');
    expect(resolveReviewPolicy(
      { labels: ['feature'] },
      { policy: 'human_or_cursor', high_risk_policy: 'human_and_cursor' },
      { allowed_existing_edits: [{ reason: 'edit', impact: { risk: 'high' } }] },
    )).toBe('human_and_cursor');
    expect(resolveReviewPolicy(
      { labels: ['feature'] },
      { policy: 'human_or_cursor', high_risk_policy: 'human_and_cursor' },
      {
        existing_code_considered: [{
          reason: 'GitNexus hit for "retry" (impact UNKNOWN, 0 dependents, processes: none)',
        }],
      },
    )).toBe('human_and_cursor');
    expect(resolveReviewPolicy(
      { labels: ['feature'] },
      { policy: 'human_or_cursor', high_risk_policy: 'human_and_cursor' },
      { allowed_existing_edits: [{ reason: 'edit', impact: { risk: 'unknown' } }] },
    )).toBe('human_and_cursor');
  });

  it('honors human_and_cursor', () => {
    expect(reviewAllowsMerge([review({})], 'human_and_cursor', 'abc123')).toBe(false);
    expect(reviewAllowsMerge([
      review({}),
      review({ reviewer_type: 'human' }),
    ], 'human_and_cursor', 'abc123')).toBe(true);
  });
});
