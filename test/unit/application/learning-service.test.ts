import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, access, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventBus } from '../../../src/application/event-bus.js';
import { LearningService } from '../../../src/application/learning-service.js';
import { Paths } from '../../../src/infrastructure/storage/paths.js';
import { writeYaml } from '../../../src/infrastructure/storage/fs-utils.js';

describe('LearningService', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'orch-learn-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
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

  it('emits learning:created after a meaningful goal is achieved', async () => {
    const git = async () => ({ stdout: '', stderr: '' });
    const bus = new EventBus();
    const events: Array<{ type: string; eligible?: boolean }> = [];
    bus.onAny((event) => { events.push(event); });
    const paths = new Paths(root);
    await writeYaml(paths.goalPath('goal_evt'), {
      id: 'goal_evt',
      title: 'Ship admission audit',
      description: 'Reusable architecture lesson for GitNexus reuse.',
      status: 'achieved',
      created_at: '2026-01-01T00:00:00Z',
    });
    const service = new LearningService(paths, bus, git as never);
    service.subscribe();
    bus.emit({ type: 'goal:status_changed', goalId: 'goal_evt', from: 'active', to: 'achieved' });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'learning:created' && event.eligible === true)).toBe(true);
    });
  });

  it('does not write a solutions note for a trivial achieved goal', async () => {
    const git = async () => ({ stdout: '', stderr: '' });
    const bus = new EventBus();
    const events: Array<{ type: string; eligible?: boolean }> = [];
    bus.onAny((event) => { events.push(event); });
    const paths = new Paths(root);
    await writeYaml(paths.goalPath('goal_wip'), {
      id: 'goal_wip',
      title: 'wip',
      description: '',
      status: 'achieved',
      created_at: '2026-01-01T00:00:00Z',
    });
    const service = new LearningService(paths, bus, git as never);
    service.subscribe();
    bus.emit({ type: 'goal:status_changed', goalId: 'goal_wip', from: 'active', to: 'achieved' });
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === 'learning:created' && event.eligible === false)).toBe(true);
    });
    await expect(access(path.join(root, 'docs', 'solutions'))).rejects.toThrow();
  });

  it('does not record a status-only Task ENG-N passed lesson', async () => {
    await mkdir(path.join(root, '.orchestry'), { recursive: true });
    const paths = new Paths(root);
    await writeYaml(paths.goalPath('goal_status'), {
      id: 'goal_status',
      title: 'Task ENG-142 passed',
      description: 'This task completed successfully after the worker finished the assigned work item.',
      status: 'achieved',
      created_at: '2026-01-01T00:00:00Z',
    });
    const { buildLightContainer } = await import('../../../src/container.js');
    const container = await buildLightContainer({
      projectRoot: root,
      json: false,
      quiet: true,
      noColor: true,
      ascii: true,
    });
    const events: Array<{ type: string; eligible?: boolean }> = [];
    container.eventBus.onAny((event) => { events.push(event); });
    try {
      container.eventBus.emit({
        type: 'goal:status_changed',
        goalId: 'goal_status',
        from: 'active',
        to: 'achieved',
      });
      await vi.waitFor(() => {
        expect(events.some((event) => event.type === 'learning:created' && event.eligible === false)).toBe(true);
      });
      await expect(access(path.join(root, 'docs', 'solutions'))).rejects.toThrow();
    } finally {
      await container.codeIntelligence?.close?.();
    }
  });

  it('appends GitNexus architecture seams onto a durable learning note', async () => {
    await mkdir(path.join(root, '.orchestry'), { recursive: true });
    const paths = new Paths(root);
    await writeYaml(paths.goalPath('goal_seam'), {
      id: 'goal_seam',
      title: 'Ship admission audit reuse',
      description: 'Reusable architecture lesson for GitNexus retry helpers.',
      status: 'achieved',
      created_at: '2026-01-01T00:00:00Z',
    });
    const { buildLightContainer } = await import('../../../src/container.js');
    const container = await buildLightContainer({
      projectRoot: root,
      json: false,
      quiet: true,
      noColor: true,
      ascii: true,
    });
    if (!container.codeIntelligence) throw new Error('expected code intelligence');
    container.codeIntelligence.searchExisting = async () => [{
      path: 'src/application/orchestrator.ts',
      symbol: 'enqueueRetry',
      relevance: 'high',
      decision: 'reuse',
      reason: 'existing retry',
    }];
    container.eventBus.emit({
      type: 'goal:status_changed',
      goalId: 'goal_seam',
      from: 'active',
      to: 'achieved',
    });
    try {
      await vi.waitFor(async () => {
        const files = await readdir(path.join(root, 'docs', 'solutions'));
        const md = files.find((name) => name.includes('goal_seam'));
        expect(md).toBeTruthy();
        const raw = await readFile(path.join(root, 'docs', 'solutions', md!), 'utf8');
        expect(raw).toContain('## GitNexus architecture seams');
        expect(raw).toContain('enqueueRetry');
      });
    } finally {
      await container.codeIntelligence?.close?.();
    }
  });
});
