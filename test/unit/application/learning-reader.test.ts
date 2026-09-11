import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listLearnings, renderLearningContext } from '../../../src/application/learning-reader.js';

describe('listLearnings', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'orch-learn-read-'));
    await mkdir(path.join(root, 'docs', 'solutions'), { recursive: true });
    await writeFile(
      path.join(root, 'docs', 'solutions', '2026-01-01-goal_abc.md'),
      ['---', 'title: Ship admission', 'goal_id: goal_abc', '---', '', 'Prefer reuse over new helpers.', ''].join('\n'),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('surfaces committed solutions for later planning', async () => {
    const notes = await listLearnings(root);
    expect(notes[0]?.title).toBe('Ship admission');
    expect(renderLearningContext(notes)).toContain('docs/solutions/2026-01-01-goal_abc.md');
  });

  it('skips ce-compound-refresh stale notes and still fills the limit', async () => {
    await writeFile(
      path.join(root, 'docs', 'solutions', '2026-02-01-goal_stale.md'),
      ['---', 'title: Old backoff helper', 'status: stale', 'stale_reason: superseded', '---', '', 'Do not reuse.', ''].join('\n'),
    );
    await writeFile(
      path.join(root, 'docs', 'solutions', '2025-12-01-goal_old.md'),
      ['---', 'title: Older current lesson', 'goal_id: goal_old', '---', '', 'Keep using the shared store.', ''].join('\n'),
    );
    const notes = await listLearnings(root, 1);
    expect(notes.map((note) => note.title)).toEqual(['Ship admission']);
    expect(notes.some((note) => note.title === 'Old backoff helper')).toBe(false);
    const filled = await listLearnings(root, 2);
    expect(filled.map((note) => note.title)).toEqual(['Ship admission', 'Older current lesson']);
  });
});
