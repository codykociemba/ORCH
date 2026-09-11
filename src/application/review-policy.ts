/**
 * Merge review policy (spec §9.1). Fail closed when a required reviewer is missing.
 */

import type { ReviewEvidence } from '../domain/evidence.js';

export type ReviewPolicy = 'human' | 'cursor' | 'human_or_cursor' | 'human_and_cursor';

/** Spec §9.1 / addendum §41: high-risk labels or HIGH/CRITICAL/UNKNOWN GitNexus impact may require both human and Cursor. */
export function resolveReviewPolicy(
  task: { labels: string[] },
  review?: { policy?: ReviewPolicy; high_risk_policy?: ReviewPolicy } | null,
  contract?: {
    existing_code_considered?: Array<{ reason?: string }>;
    allowed_existing_edits?: Array<{ reason?: string; impact?: { risk?: string } }>;
  } | null,
): ReviewPolicy {
  const base = review?.policy ?? 'human_or_cursor';
  const labeledHighRisk = task.labels.some((label) =>
    /^(high|critical|council-required|high-risk)$/i.test(label.trim())
    || /\b(high-risk|critical)\b/i.test(label),
  );
  const considered = contract?.existing_code_considered ?? [];
  const edits = contract?.allowed_existing_edits ?? [];
  const impactHigh = considered.some((item: { reason?: string }) =>
    /impact (HIGH|CRITICAL|UNKNOWN)\b/i.test(item.reason ?? ''),
  ) || edits.some((item: { reason?: string; impact?: { risk?: string } }) =>
    /^(high|critical|unknown)$/i.test(item.impact?.risk ?? '')
    || /impact (HIGH|CRITICAL|UNKNOWN)\b/i.test(item.reason ?? ''),
  );
  if ((labeledHighRisk || impactHigh) && review?.high_risk_policy) return review.high_risk_policy;
  return base;
}

export function reviewAllowsMerge(
  reviews: ReviewEvidence[],
  policy: ReviewPolicy,
  headSha?: string,
): boolean {
  const approved = reviews.filter((review) =>
    review.verdict === 'approve' && (!headSha || review.commit_sha === headSha),
  );
  const human = approved.some((review) => review.reviewer_type === 'human');
  const cursor = approved.some((review) => review.reviewer_type === 'cursor');
  switch (policy) {
    case 'human':
      return human;
    case 'cursor':
      return cursor;
    case 'human_and_cursor':
      return human && cursor;
    default:
      return human || cursor;
  }
}
