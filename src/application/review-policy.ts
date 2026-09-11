/**
 * Merge review policy (spec §9.1). Fail closed when a required reviewer is missing.
 */

import type { ReviewEvidence } from '../domain/evidence.js';

export type ReviewPolicy = 'human' | 'cursor' | 'human_or_cursor' | 'human_and_cursor';

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
