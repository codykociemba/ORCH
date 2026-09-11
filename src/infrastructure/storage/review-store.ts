/**
 * Persist ReviewEvidence per task (Cursor CI ingest, human reviews).
 */

import type { Paths } from './paths.js';
import { readJson, writeJson } from './fs-utils.js';
import type { ReviewEvidence } from '../../domain/evidence.js';

export class ReviewStore {
  constructor(private readonly paths: Paths) {}

  async list(taskId: string): Promise<ReviewEvidence[]> {
    const file = await readJson<{ reviews?: ReviewEvidence[] }>(this.paths.reviewsPath(taskId));
    return file?.reviews ?? [];
  }

  async append(taskId: string, review: ReviewEvidence): Promise<ReviewEvidence[]> {
    const reviews = await this.list(taskId);
    const next = [...reviews.filter((item) => item.commit_sha !== review.commit_sha || item.reviewer_type !== review.reviewer_type), review];
    await writeJson(this.paths.reviewsPath(taskId), { reviews: next });
    return next;
  }
}
