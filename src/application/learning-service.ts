/**
 * Compound Engineering learning eligibility after a goal completes.
 * Writes docs/solutions/ and commits that file when git is available.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EventBus } from './event-bus.js';
import type { Paths } from '../infrastructure/storage/paths.js';
import path from 'node:path';
import { writeJson, atomicWrite } from '../infrastructure/storage/fs-utils.js';
import type { Goal } from '../domain/goal.js';

const execFileAsync = promisify(execFile);

export interface LearningRecord {
  goal_id: string;
  eligible: boolean;
  reason: string;
  created_at: string;
  committed?: boolean;
}

export class LearningService {
  constructor(
    private readonly paths: Paths,
    private readonly eventBus: EventBus,
    private readonly git: typeof execFileAsync = execFileAsync,
  ) {}

  subscribe(): void {
    this.eventBus.on('goal:status_changed', (event) => {
      if (event.to === 'achieved') {
        void this.record({ id: event.goalId, title: '' });
      }
    });
  }

  async record(goal: Pick<Goal, 'id' | 'title'>): Promise<LearningRecord> {
    const record: LearningRecord = {
      goal_id: goal.id,
      eligible: true,
      reason: 'Goal achieved — consider ce-compound / ce-compound-refresh for durable learnings.',
      created_at: new Date().toISOString(),
      committed: false,
    };
    await writeJson(this.paths.learningPath(goal.id), record);
    const day = record.created_at.slice(0, 10);
    const relative = path.join('docs', 'solutions', `${day}-${goal.id}.md`);
    const md = [
      '---',
      `title: ${goal.title || goal.id}`,
      `goal_id: ${goal.id}`,
      `date: ${day}`,
      'source: orch-learning',
      '---',
      '',
      record.reason,
      '',
      'Refresh later with `ce-compound-refresh` if this learning goes stale.',
      '',
    ].join('\n');
    await atomicWrite(path.join(this.paths.repoRoot, relative), md);
    record.committed = await this.commitLearning(relative, goal.id);
    await writeJson(this.paths.learningPath(goal.id), record);
    return record;
  }

  private async commitLearning(relativePath: string, goalId: string): Promise<boolean> {
    try {
      await this.git('git', ['add', '--', relativePath], { cwd: this.paths.repoRoot });
      await this.git('git', ['commit', '-m', `docs: record learning for ${goalId}`], { cwd: this.paths.repoRoot });
      return true;
    } catch {
      return false;
    }
  }
}
