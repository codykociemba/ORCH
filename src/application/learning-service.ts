/**
 * Compound Engineering learning eligibility after a goal completes.
 * Writes docs/solutions/ and commits that file when git is available.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EventBus } from './event-bus.js';
import type { Paths } from '../infrastructure/storage/paths.js';
import path from 'node:path';
import { writeJson, atomicWrite, readYaml } from '../infrastructure/storage/fs-utils.js';
import type { Goal } from '../domain/goal.js';

const TRIVIAL_TITLE = /^(test|wip|tmp|todo|fix typo|n\/a)(\b|$)/i;
const MEANINGFUL = /architect|convention|integrat|edge case|fail(ed|ure)|avoid|test(ing)?|operat|security|reliab|root cause|admission|reuse|council|linear|workflow|audit/i;

function isMeaningfulLearning(goal: Pick<Goal, 'title' | 'description'>): boolean {
  const title = goal.title.trim();
  const text = `${title} ${goal.description}`.trim();
  if (title.length < 8 || TRIVIAL_TITLE.test(title)) return false;
  return MEANINGFUL.test(text) || goal.description.trim().length >= 40;
}

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
      if (event.to !== 'achieved') return;
      void (async () => {
        const goal = await readYaml<Goal>(this.paths.goalPath(event.goalId));
        const title = goal?.title ?? '';
        const description = goal?.description ?? '';
        if (!isMeaningfulLearning({ title, description })) {
          this.eventBus.emit({
            type: 'learning:created',
            goalId: event.goalId,
            eligible: false,
          });
          return;
        }
        const record = await this.record({ id: event.goalId, title });
        this.eventBus.emit({
          type: 'learning:created',
          goalId: record.goal_id,
          eligible: record.eligible,
        });
      })();
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
