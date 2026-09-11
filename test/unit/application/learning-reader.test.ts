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
});
