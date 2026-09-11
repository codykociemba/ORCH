/**
 * `orch review` — ingest Cursor/human ReviewEvidence bound to a commit SHA.
 */

import type { Command } from 'commander';
import type { LightContainer } from '../../container.js';
import { printError, printKeyValue, printSuccess } from '../output.js';
import { ReviewStore } from '../../infrastructure/storage/review-store.js';
import { readJson } from '../../infrastructure/storage/fs-utils.js';
import { parseCursorReview, toReviewEvidence } from '../../application/cursor-review.js';
import type { ReviewEvidence } from '../../domain/evidence.js';

export function registerReviewCommand(program: Command, container: LightContainer): void {
  const review = program
    .command('review')
    .description('Ingest PR review evidence bound to a commit SHA');

  const store = new ReviewStore(container.paths);

  review
    .command('ingest <file>')
    .description('Attach a Cursor/human review JSON to a task and notify Linear')
    .requiredOption('--task <taskId>', 'ORCH task id')
    .option('--sha <sha>', 'Commit SHA if the file omits it')
    .action(async (file: string, opts: { task: string; sha?: string }) => {
      const task = await container.taskStore.get(opts.task);
      if (!task) {
        printError(`Task not found: ${opts.task}`);
        process.exitCode = 1;
        return;
      }
      let raw: Partial<ReviewEvidence> | null = null;
      try {
        raw = await readJson<Partial<ReviewEvidence>>(file);
      } catch {
        raw = null;
      }
      raw ??= await readTextAsReview(file);
      if (!raw) {
        printError('Review file is empty or unreadable');
        process.exitCode = 1;
        return;
      }
      const evidence = normalizeReview(raw, opts.sha ?? task.proof?.head_sha);
      if (!evidence.commit_sha) {
        printError('Review must include commit_sha (or pass --sha)');
        process.exitCode = 1;
        return;
      }
      await store.append(task.id, evidence);
      await container.integrationService.recordReview(task, evidence);
      printSuccess(`${evidence.verdict} @ ${evidence.commit_sha.slice(0, 7)}`);
    });

  review
    .command('list <taskId>')
    .description('List stored reviews for a task')
    .action(async (taskId: string) => {
      const reviews = await store.list(taskId);
      if (container.context.json) {
        console.log(JSON.stringify(reviews, null, 2));
        return;
      }
      if (reviews.length === 0) {
        console.log('  No reviews');
        return;
      }
      for (const item of reviews) {
        printKeyValue([
          ['SHA', item.commit_sha],
          ['Verdict', item.verdict],
          ['Reviewer', item.reviewer_type],
          ['Summary', item.summary],
        ]);
      }
    });
}

async function readTextAsReview(file: string): Promise<Partial<ReviewEvidence> | null> {
  const { readFile } = await import('node:fs/promises');
  try {
    const text = await readFile(file, 'utf8');
    return parseCursorReview(text);
  } catch {
    return null;
  }
}

function normalizeReview(
  raw: Partial<ReviewEvidence>,
  sha?: string,
): ReviewEvidence {
  if (raw.reviewer_type && raw.commit_sha && raw.verdict && raw.summary && raw.timestamp) {
    return raw as ReviewEvidence;
  }
  const parsed = parseCursorReview(JSON.stringify(raw), sha);
  return toReviewEvidence(parsed, { commitSha: sha ?? parsed.commit_sha ?? '' });
}
