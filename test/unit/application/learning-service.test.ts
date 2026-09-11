import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventBus } from '../../../src/application/event-bus.js';
import { LearningService } from '../../../src/application/learning-service.js';
import { Paths } from '../../../src/infrastructure/storage/paths.js';

describe('LearningService', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'orch-learn-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes a durable eligibility record', async () => {
    const git = async () => ({ stdout: '', stderr: '' });
    const service = new LearningService(new Paths(root), new EventBus(), git as never);
    const record = await service.record({ id: 'goal_abc', title: 'Ship admission' });
    expect(record.eligible).toBe(true);
    expect(record.committed).toBe(true);
    const raw = await readFile(path.join(root, '.orchestry', 'learnings', 'goal_abc.json'), 'utf-8');
    expect(raw).toContain('ce-compound');
    const solution = await readFile(path.join(root, 'docs', 'solutions', `${record.created_at.slice(0, 10)}-goal_abc.md`), 'utf-8');
    expect(solution).toContain('goal_id: goal_abc');
  });
});
