import { describe, it, expect, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  LiquidTemplateEngine,
  buildPromptContext,
  filterRelevantContext,
  DEFAULT_PROMPT_TEMPLATE,
  DEFAULT_SYSTEM_TEMPLATE,
  DEFAULT_USER_TEMPLATE,
  type RetryContext,
} from '../../../src/infrastructure/template/template-engine.js';
import type { Task } from '../../../src/domain/task.js';
import type { Agent } from '../../../src/domain/agent.js';
import { DEFAULT_CONFIG } from '../../../src/domain/config.js';

vi.mock('../../../src/infrastructure/code-intelligence/gitnexus-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/infrastructure/code-intelligence/gitnexus-adapter.js')>();
  return {
    ...actual,
    createLazyCodeIntelligence: () => ({
      getRepositoryStatus: async () => ({
        provider: 'gitnexus' as const,
        repo: 'test',
        available: true,
        current: true,
        incomplete_reasons: [],
      }),
      searchExisting: async () => [],
      getSymbolContext: async () => ({
        symbol: 'x',
        callers: [],
        callees: [],
        processes: [],
        raw: { processes: [], affected_processes: [{ process: 'HandleRunFailure' }, { label: 'AuditTask' }] },
      }),
      getImpact: async () => ({
        target: 'x',
        risk: 'low' as const,
        direct_dependents: 0,
        total_dependents: 0,
        processes: [],
        unresolved: true,
        raw: { processes: [], affected_processes: [{ process: 'HandleRunFailure' }, { label: 'AuditTask' }] },
      }),
      getProcesses: async () => [],
      detectChanges: async () => ({
        added_symbols: [],
        modified_symbols: [],
        deleted_symbols: [],
        processes: [],
        risk: 'low' as const,
        partial: false,
        truncated: false,
        degraded: false,
        worktree: '',
        raw: { processes: [], affected_processes: [{ process: 'HandleRunFailure' }, { label: 'AuditTask' }] },
      }),
    }),
  };
});

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'tsk_test1',
    title: 'Test task',
    description: 'Do something',
    status: 'todo',
    priority: 3,
    labels: [],
    depends_on: [],
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    attempts: 0,
    max_attempts: 3,
    ...overrides,
  };
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agt_test1',
    name: 'test-agent',
    adapter: 'claude',
    config: {
      approval_policy: 'suggest',
      max_turns: 50,
      timeout_ms: 3600000,
      stall_timeout_ms: 300000,
    },
    status: 'idle',
    stats: {
      tasks_completed: 0,
      tasks_failed: 0,
      total_runs: 0,
      total_runtime_ms: 0,
    },
    ...overrides,
  };
}

describe('buildPromptContext', () => {
  it('should not include retry context on first attempt', () => {
    const ctx = buildPromptContext(
      makeTask(),
      makeAgent(),
      1,
      '/workspace',
      DEFAULT_CONFIG,
    );

    expect(ctx.attempt).toBeNull();
    expect(ctx.retry).toBeUndefined();
  });

  it('should include retry context on attempt > 1 when retryContext provided', () => {
    const retryContext: RetryContext = {
      previous_error: 'Process crashed',
      previous_output: 'some output\nmore output',
    };

    const ctx = buildPromptContext(
      makeTask(),
      makeAgent(),
      2,
      '/workspace',
      DEFAULT_CONFIG,
      { allAgents: [], retryContext },
    );

    expect(ctx.attempt).toBe(2);
    expect(ctx.retry).toEqual(retryContext);
  });

  it('should not include retry context on attempt > 1 when retryContext is undefined', () => {
    const ctx = buildPromptContext(
      makeTask(),
      makeAgent(),
      2,
      '/workspace',
      DEFAULT_CONFIG,
      { allAgents: [] },
    );

    expect(ctx.attempt).toBe(2);
    expect(ctx.retry).toBeUndefined();
  });

  it('should ignore retryContext on first attempt even if provided', () => {
    const retryContext: RetryContext = {
      previous_error: 'Some error',
      previous_output: 'output',
    };

    const ctx = buildPromptContext(
      makeTask(),
      makeAgent(),
      1,
      '/workspace',
      DEFAULT_CONFIG,
      { allAgents: [], retryContext },
    );

    expect(ctx.attempt).toBeNull();
    expect(ctx.retry).toBeUndefined();
  });
});

describe('buildPromptContext team listing', () => {
  const multilineRole = 'Senior Backend Developer\n## WORKFLOW\n1) Step one\n2) Step two\n## RULES\n- Rule A\n- Rule B';
  const longFirstLine = 'A'.repeat(100);

  it('passes full role for other agents', () => {
    const current = makeAgent({ id: 'agt_me', name: 'Me', role: 'My full role' });
    const other = makeAgent({ id: 'agt_other', name: 'Other', role: multilineRole });

    const ctx = buildPromptContext(
      makeTask(),
      current,
      1,
      '/workspace',
      DEFAULT_CONFIG,
      { allAgents: [current, other] },
    );

    const otherInCtx = ctx.agents.find((a) => a.id === 'agt_other')!;
    expect(otherInCtx.role).toBe(multilineRole);
  });

  it('passes long role without truncation', () => {
    const other = makeAgent({ id: 'agt_long', name: 'Long', role: longFirstLine });
    const current = makeAgent({ id: 'agt_me', name: 'Me' });

    const ctx = buildPromptContext(
      makeTask(),
      current,
      1,
      '/workspace',
      DEFAULT_CONFIG,
      { allAgents: [current, other] },
    );

    const longInCtx = ctx.agents.find((a) => a.id === 'agt_long')!;
    expect(longInCtx.role).toBe(longFirstLine);
  });

  it('excludes current agent role from team listing', () => {
    const current = makeAgent({ id: 'agt_me', name: 'Me', role: multilineRole });

    const ctx = buildPromptContext(
      makeTask(),
      current,
      1,
      '/workspace',
      DEFAULT_CONFIG,
      { allAgents: [current] },
    );

    const meInCtx = ctx.agents.find((a) => a.id === 'agt_me')!;
    expect(meInCtx.role).toBeUndefined();
  });

  it('preserves undefined role', () => {
    const other = makeAgent({ id: 'agt_norole', name: 'NoRole', role: undefined });
    const current = makeAgent({ id: 'agt_me', name: 'Me' });

    const ctx = buildPromptContext(
      makeTask(),
      current,
      1,
      '/workspace',
      DEFAULT_CONFIG,
      { allAgents: [current, other] },
    );

    const noRoleInCtx = ctx.agents.find((a) => a.id === 'agt_norole')!;
    expect(noRoleInCtx.role).toBeUndefined();
  });

  it('keeps short single-line role as-is', () => {
    const other = makeAgent({ id: 'agt_short', name: 'Short', role: 'QA Engineer' });
    const current = makeAgent({ id: 'agt_me', name: 'Me' });

    const ctx = buildPromptContext(
      makeTask(),
      current,
      1,
      '/workspace',
      DEFAULT_CONFIG,
      { allAgents: [current, other] },
    );

    const shortInCtx = ctx.agents.find((a) => a.id === 'agt_short')!;
    expect(shortInCtx.role).toBe('QA Engineer');
  });
});

describe('LiquidTemplateEngine timeout', () => {
  it('renders normally within timeout', async () => {
    const engine = new LiquidTemplateEngine({ renderTimeoutMs: 5000 });
    const ctx = buildPromptContext(
      makeTask(),
      makeAgent(),
      1,
      '/workspace',
      DEFAULT_CONFIG,
    );
    const result = await engine.render('Hello {{ agent.name }}', ctx);
    expect(result).toBe('Hello test-agent');
  });

  it('accepts default constructor (no options)', () => {
    const engine = new LiquidTemplateEngine();
    expect(engine).toBeDefined();
  });

  it('disables timeout when renderTimeoutMs is 0', async () => {
    const engine = new LiquidTemplateEngine({ renderTimeoutMs: 0 });
    const ctx = buildPromptContext(
      makeTask(),
      makeAgent(),
      1,
      '/workspace',
      DEFAULT_CONFIG,
    );
    const result = await engine.render('Hello {{ agent.name }}', ctx);
    expect(result).toBe('Hello test-agent');
  });
});

describe('LiquidTemplateEngine with retry context', () => {
  const engine = new LiquidTemplateEngine();

  it('should render retry section when retry context is present', async () => {
    const ctx = buildPromptContext(
      makeTask(),
      makeAgent({ name: 'Backend A', role: 'developer' }),
      2,
      '/workspace',
      DEFAULT_CONFIG,
      {
        allAgents: [],
        retryContext: {
          previous_error: 'npm test failed with exit code 1',
          previous_output: 'FAIL src/app.test.ts\nError: assertion failed',
        },
      },
    );

    const result = await engine.render(DEFAULT_PROMPT_TEMPLATE, ctx);

    expect(result).toContain('Previous attempt failed');
    expect(result).toContain('npm test failed with exit code 1');
    expect(result).toContain('FAIL src/app.test.ts');
    expect(result).toContain('Do NOT repeat the same steps');
    expect(result).toContain('Attempt: 2');
  });

  it('should not render retry section on first attempt', async () => {
    const ctx = buildPromptContext(
      makeTask(),
      makeAgent({ name: 'Backend A' }),
      1,
      '/workspace',
      DEFAULT_CONFIG,
    );

    const result = await engine.render(DEFAULT_PROMPT_TEMPLATE, ctx);

    expect(result).not.toContain('Previous attempt failed');
    expect(result).not.toContain('previous_error');
  });

  it('should render retry section without output when output is empty', async () => {
    const ctx = buildPromptContext(
      makeTask(),
      makeAgent({ name: 'Backend A' }),
      3,
      '/workspace',
      DEFAULT_CONFIG,
      {
        allAgents: [],
        retryContext: {
          previous_error: 'Agent stalled',
          previous_output: '',
        },
      },
    );

    const result = await engine.render(DEFAULT_PROMPT_TEMPLATE, ctx);

    expect(result).toContain('Previous attempt failed');
    expect(result).toContain('Agent stalled');
    expect(result).toContain('Attempt: 3');
    // Empty output should not render "Last output" block
    expect(result).not.toContain('Last output');
  });
});

describe('filterRelevantContext', () => {
  it('returns empty object for empty context', () => {
    const result = filterRelevantContext({}, { agentName: 'Backend A' });
    expect(result).toEqual({});
  });

  it('prioritizes goal_id prefix match', () => {
    const ctx: Record<string, string> = {
      'goal_abc-progress': 'done 3/5 tasks',
      'unrelated-key': 'some value',
      'other-goal-key': 'other value',
    };
    const result = filterRelevantContext(ctx, { agentName: 'Backend A', goalId: 'goal_abc' });
    const keys = Object.keys(result);
    expect(keys[0]).toBe('goal_abc-progress');
  });

  it('prioritizes agent name match in key', () => {
    const ctx: Record<string, string> = {
      'backend-a-status': 'ready',
      'qa-status': 'waiting',
    };
    const result = filterRelevantContext(ctx, { agentName: 'Backend A' });
    const keys = Object.keys(result);
    // backend a matches agent name, should be first
    expect(keys[0]).toBe('backend-a-status');
  });

  it('matches agent name in value', () => {
    const ctx: Record<string, string> = {
      'some-result': 'Backend A completed the fix',
      'other-result': 'QA passed all tests',
    };
    const result = filterRelevantContext(ctx, { agentName: 'Backend A' });
    const keys = Object.keys(result);
    expect(keys[0]).toBe('some-result');
  });

  it('matches scope paths', () => {
    const ctx: Record<string, string> = {
      'tui-fix': 'fixed TUI rendering',
      'api-refactor': 'refactored src/api endpoints',
    };
    const result = filterRelevantContext(ctx, {
      agentName: 'Backend A',
      taskScope: ['src/api/**'],
    });
    const keys = Object.keys(result);
    expect(keys[0]).toBe('api-refactor');
  });

  it('matches role-prefix keywords', () => {
    const ctx: Record<string, string> = {
      'backend-dedup-done': 'dedup completed',
      'frontend-fix': 'UI fix applied',
      'qa-result': 'tests passed',
    };
    const result = filterRelevantContext(ctx, { agentName: 'Backend A' });
    const keys = Object.keys(result);
    expect(keys[0]).toBe('backend-dedup-done');
  });

  it('limits to MAX_CONTEXT_ENTRIES (15)', () => {
    const ctx: Record<string, string> = {};
    for (let i = 0; i < 30; i++) {
      ctx[`key-${i}`] = `value-${i}`;
    }
    const result = filterRelevantContext(ctx, { agentName: 'Backend A' });
    expect(Object.keys(result).length).toBeLessThanOrEqual(15);
  });

  it('passes long values without truncation', () => {
    const longValue = 'x'.repeat(600);
    const ctx: Record<string, string> = {
      'long-entry': longValue,
    };
    const result = filterRelevantContext(ctx, { agentName: 'Backend A' });
    expect(result['long-entry']).toBe(longValue);
  });

  it('includes zero-score entries when under limit', () => {
    const ctx: Record<string, string> = {
      'random-key-1': 'value1',
      'random-key-2': 'value2',
    };
    const result = filterRelevantContext(ctx, { agentName: 'Backend A' });
    expect(Object.keys(result).length).toBe(2);
  });

  it('front-end agent matches tui- and frontend- prefixes', () => {
    const ctx: Record<string, string> = {
      'tui-fix': 'TUI fix applied',
      'frontend-design': 'new design',
      'backend-status': 'ready',
    };
    const result = filterRelevantContext(ctx, { agentName: 'Front-End' });
    const keys = Object.keys(result);
    // tui- and frontend- should score higher than backend-
    expect(keys.indexOf('tui-fix')).toBeLessThan(keys.indexOf('backend-status'));
    expect(keys.indexOf('frontend-design')).toBeLessThan(keys.indexOf('backend-status'));
  });

  it('buildPromptContext applies filtering to shared_context', () => {
    const ctx: Record<string, string> = {};
    for (let i = 0; i < 30; i++) {
      ctx[`unrelated-${i}`] = 'x'.repeat(600);
    }
    ctx['goal_test-progress'] = 'goal progress';

    const result = buildPromptContext(
      makeTask({ goalId: 'goal_test' }),
      makeAgent({ name: 'Backend A' }),
      1,
      '/workspace',
      DEFAULT_CONFIG,
      { sharedContext: ctx },
    );

    // Should be filtered by relevance (max 15 entries)
    expect(Object.keys(result.shared_context!).length).toBeLessThanOrEqual(15);
    // Goal context should be prioritized
    expect(result.shared_context!['goal_test-progress']).toBe('goal progress');
  });

  it('boosts bug-/perf-/docs- prefix entries slightly', () => {
    const ctx: Record<string, string> = {
      'bug-123': 'critical bug found',
      'perf-baseline': 'CLI 40ms',
      'random-stuff': 'nothing relevant',
    };
    const result = filterRelevantContext(ctx, { agentName: 'Reviewer' });
    const keys = Object.keys(result);
    // bug- and perf- should come before random-stuff
    expect(keys.indexOf('bug-123')).toBeLessThan(keys.indexOf('random-stuff'));
    expect(keys.indexOf('perf-baseline')).toBeLessThan(keys.indexOf('random-stuff'));
  });
});

describe('system/user template split', () => {
  const engine = new LiquidTemplateEngine({ renderTimeoutMs: 5000 });

  const ctx = buildPromptContext(
    makeTask({ title: 'Fix bug', description: 'Fix the login bug', labels: ['auto'] }),
    makeAgent({ name: 'Backend A', role: 'Senior Dev' }),
    1,
    '/workspace',
    DEFAULT_CONFIG,
    { allAgents: [makeAgent({ name: 'Backend A', role: 'Senior Dev' })] },
  );

  it('DEFAULT_PROMPT_TEMPLATE equals system + user concatenation', () => {
    expect(DEFAULT_PROMPT_TEMPLATE).toBe(DEFAULT_SYSTEM_TEMPLATE + '\n' + DEFAULT_USER_TEMPLATE);
  });

  it('system template contains agent identity and CLI reference', async () => {
    const rendered = await engine.render(DEFAULT_SYSTEM_TEMPLATE, ctx);
    expect(rendered).toContain('You are Backend A (Senior Dev)');
    expect(rendered).toContain('orch task add');
    expect(rendered).toContain('orch msg send');
    expect(rendered).toContain('orch context set');
    expect(rendered).toContain('## Rules');
  });

  it('system template does NOT contain task-specific content', async () => {
    const rendered = await engine.render(DEFAULT_SYSTEM_TEMPLATE, ctx);
    expect(rendered).not.toContain('## Task:');
    expect(rendered).not.toContain('Fix bug');
    expect(rendered).not.toContain('## Context');
    expect(rendered).not.toContain('## Team');
  });

  it('user template contains task details and team listing', async () => {
    const rendered = await engine.render(DEFAULT_USER_TEMPLATE, ctx);
    expect(rendered).toContain('## Task: Fix bug');
    expect(rendered).toContain('Fix the login bug');
    expect(rendered).toContain('Priority: 3');
    expect(rendered).toContain('## Team');
    expect(rendered).toContain('Backend A');
  });

  it('user template does NOT contain rules or CLI reference', async () => {
    const rendered = await engine.render(DEFAULT_USER_TEMPLATE, ctx);
    expect(rendered).not.toContain('## Rules');
    expect(rendered).not.toContain('## Orchestrator CLI');
  });

  it('system template includes autonomous mode when task has auto label', async () => {
    const autoCtx = buildPromptContext(
      makeTask({ labels: ['autonomous'], goalId: 'goal_123' }),
      makeAgent(),
      1,
      '/workspace',
      DEFAULT_CONFIG,
    );
    const rendered = await engine.render(DEFAULT_SYSTEM_TEMPLATE, autoCtx);
    expect(rendered).toContain('## Autonomous Goal Mode');
    expect(rendered).toContain('goal_123');
  });

  it('system template omits autonomous mode for regular tasks', async () => {
    const rendered = await engine.render(DEFAULT_SYSTEM_TEMPLATE, ctx);
    expect(rendered).not.toContain('## Autonomous Goal Mode');
  });

  it('user template includes goal context when provided', async () => {
    const goalCtx = buildPromptContext(
      makeTask(),
      makeAgent(),
      1,
      '/workspace',
      DEFAULT_CONFIG,
      {
        goal: {
          id: 'goal_abc',
          title: 'Ship v1',
          description: 'Release version 1.0',
          status: 'active',
          task_names: ['[done] Setup', '[todo] Deploy'],
        },
      },
    );
    const rendered = await engine.render(DEFAULT_USER_TEMPLATE, goalCtx);
    expect(rendered).toContain('## Goal: Ship v1');
    expect(rendered).toContain('Release version 1.0');
  });

  it('user template includes feedback when provided', async () => {
    const fbCtx = buildPromptContext(
      makeTask(),
      makeAgent(),
      1,
      '/workspace',
      DEFAULT_CONFIG,
      { feedback: 'Fix the error handling' },
    );
    const rendered = await engine.render(DEFAULT_USER_TEMPLATE, fbCtx);
    expect(rendered).toContain('## Review Feedback');
    expect(rendered).toContain('Fix the error handling');
  });

  it('user template includes retry context on attempt > 1', async () => {
    const retryCtx = buildPromptContext(
      makeTask(),
      makeAgent(),
      2,
      '/workspace',
      DEFAULT_CONFIG,
      { retryContext: { previous_error: 'timeout', previous_output: 'partial' } },
    );
    const rendered = await engine.render(DEFAULT_USER_TEMPLATE, retryCtx);
    expect(rendered).toContain('## Previous attempt failed');
    expect(rendered).toContain('timeout');
  });
});

describe('dispatch conventions prompt (container template wrap)', () => {
  it('injects prior docs/solutions learnings into the worker prompt', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-learn-prompt-'));
    try {
      await mkdir(path.join(root, '.orchestry'), { recursive: true });
      await mkdir(path.join(root, 'docs', 'solutions'), { recursive: true });
      await writeFile(
        path.join(root, 'docs', 'solutions', 'note.md'),
        ['---', 'title: Reuse existing admission audit', 'goal_id: goal_learn', '---', '', 'Do not invent a second code graph.', ''].join('\n'),
        'utf8',
      );
      const { buildFullContainer } = await import('../../../src/container.js');
      const container = await buildFullContainer({
        projectRoot: root,
        json: false,
        quiet: true,
        noColor: true,
        ascii: true,
      });
      const ctx = buildPromptContext(makeTask(), makeAgent(), 1, root, DEFAULT_CONFIG);
      const rendered = await container.templateEngine.render('Hello {{ project.name }}', ctx);
      expect(rendered).toContain('## Prior learnings (docs/solutions)');
      expect(rendered).toContain('Reuse existing admission audit');
      expect(rendered).toContain('docs/solutions/note.md');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('injects YAML-rendered conventions once per prompt context when enabled', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-conv-prompt-'));
    try {
      await mkdir(path.join(root, '.orchestry'), { recursive: true });
      await mkdir(path.join(root, '.orch'), { recursive: true });
      await writeFile(
        path.join(root, '.orch', 'workflow.yml'),
        [
          'version: 1',
          'conventions:',
          '  enabled: true',
          '  organization:',
          '    allowed_new_file_roots: [src/, test/]',
          '    max_new_files_per_task: 3',
          '',
        ].join('\n'),
        'utf8',
      );
      const { buildFullContainer } = await import('../../../src/container.js');
      const container = await buildFullContainer({
        projectRoot: root,
        json: false,
        quiet: true,
        noColor: true,
        ascii: true,
      });
      const ctx = buildPromptContext(makeTask(), makeAgent(), 1, root, DEFAULT_CONFIG);
      const first = await container.templateEngine.render('Hello {{ project.name }}', ctx);
      const second = await container.templateEngine.render('Again {{ project.name }}', ctx);
      expect(first).toContain('## Worker code context');
      expect(first).toContain(`worktree_path: ${root}`);
      expect(first).toContain('gitnexus.worktree:');
      expect(first).toContain('## Project Conventions (enforced at merge)');
      expect(first).toContain('allowed_new_file_roots:');
      expect(first).toContain('src/');
      expect(first).toContain('max_new_files_per_task: 3');
      expect(first).not.toContain('At most 3 new files per task.');
      expect(first).not.toMatch(/## Skills/);
      expect(second).not.toContain('## Project Conventions (enforced at merge)');
      expect(second).not.toContain('## Worker code context');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('overlays .orch/conventions.yml onto workflow conventions', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-conv-file-'));
    try {
      await mkdir(path.join(root, '.orchestry'), { recursive: true });
      await mkdir(path.join(root, '.orch'), { recursive: true });
      await writeFile(
        path.join(root, '.orch', 'workflow.yml'),
        [
          'version: 1',
          'conventions:',
          '  enabled: true',
          '  organization:',
          '    max_new_files_per_task: 8',
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        path.join(root, '.orch', 'conventions.yml'),
        [
          'version: 1',
          'organization:',
          '  max_new_files_per_task: 3',
          '  no_parallel_utils: true',
          '',
        ].join('\n'),
        'utf8',
      );
      const { buildLightContainer } = await import('../../../src/container.js');
      const container = await buildLightContainer({
        projectRoot: root,
        json: false,
        quiet: true,
        noColor: true,
        ascii: true,
      });
      const conventions = (container.workflowConfig as {
        conventions?: { organization?: { max_new_files_per_task?: number } };
      } | null)?.conventions;
      expect(conventions?.organization?.max_new_files_per_task).toBe(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stamps reuse candidates and recommended edits onto the plan contract', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-reuse-contract-'));
    try {
      await mkdir(path.join(root, '.orchestry'), { recursive: true });
      await mkdir(path.join(root, '.orch'), { recursive: true });
      await writeFile(
        path.join(root, '.orch', 'workflow.yml'),
        ['version: 1', 'code_admission:', '  enabled: true', ''].join('\n'),
        'utf8',
      );
      const { buildFullContainer } = await import('../../../src/container.js');
      const container = await buildFullContainer({
        projectRoot: root,
        json: false,
        quiet: true,
        noColor: true,
        ascii: true,
      });
      const task = makeTask({ id: 'tsk_reuse_stamp', status: 'todo', workspace: root });
      await container.taskStore.save(task);
      const contract = await container.codeAdmissionService.applyReuseCreates(task, {
        searches: ['retry'],
        candidates: [{
          path: 'src/retry.ts',
          symbol: 'retry',
          relevance: 'high',
          decision: 'reuse',
          reason: 'GitNexus hit for "retry" (impact MEDIUM, 4 dependents, processes: RetryFlow)',
        }],
        recommended_edits: [{
          path: 'src/retry.ts',
          symbol: 'retry',
          reason: 'GitNexus hit for "retry" (impact MEDIUM, 4 dependents, processes: RetryFlow)',
        }],
        proposed_creates: [],
        incomplete: false,
        reasons: [],
      });
      expect(contract?.existing_code_considered.some((item) => item.symbol === 'retry')).toBe(true);
      expect(contract?.allowed_existing_edits.some((item) => item.symbol === 'retry' && item.impact?.risk === 'medium')).toBe(true);
      expect(contract?.allowed_existing_edits[0]?.impact?.direct_dependents).toBe(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not authorize HIGH/CRITICAL/UNKNOWN recommended edits onto the contract', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-reuse-high-'));
    try {
      await mkdir(path.join(root, '.orchestry'), { recursive: true });
      await mkdir(path.join(root, '.orch'), { recursive: true });
      await writeFile(
        path.join(root, '.orch', 'workflow.yml'),
        ['version: 1', 'code_admission:', '  enabled: true', ''].join('\n'),
        'utf8',
      );
      const { buildFullContainer } = await import('../../../src/container.js');
      const container = await buildFullContainer({
        projectRoot: root,
        json: false,
        quiet: true,
        noColor: true,
        ascii: true,
      });
      const task = makeTask({ id: 'tsk_reuse_high', status: 'todo', workspace: root });
      await container.taskStore.save(task);
      const contract = await container.codeAdmissionService.applyReuseCreates(task, {
        searches: ['retry'],
        candidates: [{
          path: 'src/retry.ts',
          symbol: 'retry',
          relevance: 'high',
          decision: 'investigate',
          reason: 'GitNexus hit for "retry" (impact HIGH, 4 dependents, processes: RetryFlow)',
        }],
        recommended_edits: [{
          path: 'src/retry.ts',
          symbol: 'retry',
          reason: 'GitNexus hit for "retry" (impact HIGH, 4 dependents, processes: RetryFlow)',
        }],
        proposed_creates: [],
        incomplete: false,
        reasons: [],
      });
      expect(contract?.existing_code_considered.some((item) => item.symbol === 'retry')).toBe(true);
      expect(contract?.allowed_existing_edits.some((item) => item.symbol === 'retry')).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stamps the plan digest onto the Modification Contract', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-plan-digest-'));
    try {
      await mkdir(path.join(root, '.orchestry'), { recursive: true });
      await mkdir(path.join(root, '.orch', 'plans'), { recursive: true });
      await writeFile(
        path.join(root, '.orch', 'workflow.yml'),
        ['version: 1', 'code_admission:', '  enabled: true', ''].join('\n'),
        'utf8',
      );
      await writeFile(
        path.join(root, '.orch', 'plans', 'plan_digest_1.json'),
        JSON.stringify({
          id: 'plan_digest_1',
          title: 'Retry helper',
          digest: 'pln_live',
          units: [{ id: 'u1', title: 'Retry helper' }],
        }),
        'utf8',
      );
      const { buildFullContainer } = await import('../../../src/container.js');
      const container = await buildFullContainer({
        projectRoot: root,
        json: false,
        quiet: true,
        noColor: true,
        ascii: true,
      });
      const task = makeTask({
        id: 'tsk_plan_digest',
        status: 'todo',
        workspace: root,
        plan_id: 'plan_digest_1',
        plan_unit_id: 'u1',
      });
      await container.taskStore.save(task);
      const contract = await container.codeAdmissionService.applyReuseCreates(task, {
        searches: ['retry'],
        candidates: [],
        recommended_edits: [],
        proposed_creates: [],
        incomplete: false,
        reasons: [],
      });
      expect(contract?.plan_digest).toBe('pln_live');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not authorize proposed creates when GitNexus reuse is incomplete', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-reuse-incomplete-'));
    try {
      await mkdir(path.join(root, '.orchestry'), { recursive: true });
      await mkdir(path.join(root, '.orch'), { recursive: true });
      await writeFile(
        path.join(root, '.orch', 'workflow.yml'),
        ['version: 1', 'code_admission:', '  enabled: true', ''].join('\n'),
        'utf8',
      );
      const { buildFullContainer } = await import('../../../src/container.js');
      const container = await buildFullContainer({
        projectRoot: root,
        json: false,
        quiet: true,
        noColor: true,
        ascii: true,
      });
      const task = makeTask({ id: 'tsk_reuse_incomplete', status: 'todo', workspace: root });
      await container.taskStore.save(task);
      const contract = await container.codeAdmissionService.applyReuseCreates(task, {
        searches: ['retry'],
        candidates: [{
          path: 'src/retry.ts',
          symbol: 'retry',
          relevance: 'high',
          decision: 'reuse',
          reason: 'GitNexus hit for "retry" (impact MEDIUM, 4 dependents, processes: RetryFlow)',
        }],
        recommended_edits: [{
          path: 'src/retry.ts',
          symbol: 'retry',
          reason: 'GitNexus hit for "retry" (impact MEDIUM, 4 dependents, processes: RetryFlow)',
        }],
        proposed_creates: [
          { kind: 'file', path: 'src/retry-hook.ts', why_not_reuse: 'index was incomplete' },
          { kind: 'symbol', name: 'useRetry', path: 'src/retry-hook.ts', why_not_reuse: 'index was incomplete' },
        ],
        incomplete: true,
        reasons: ['stale', 'content-drift'],
      });
      expect(contract?.allowed_new_files.map((file) => file.path)).not.toContain('src/retry-hook.ts');
      expect(contract?.allowed_new_symbols.map((symbol) => symbol.name)).not.toContain('useRetry');
      expect(contract?.notes?.some((note) => /incomplete/i.test(note))).toBe(true);
      expect(contract?.existing_code_considered.some((item) => item.symbol === 'retry')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('treats unresolved low GitNexus impact as UNKNOWN', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-impact-unknown-'));
    try {
      await mkdir(path.join(root, '.orchestry'), { recursive: true });
      const { buildFullContainer } = await import('../../../src/container.js');
      const container = await buildFullContainer({
        projectRoot: root,
        json: false,
        quiet: true,
        noColor: true,
        ascii: true,
      });
      const report = await container.codeIntelligence!.getImpact({ target: 'x' });
      expect(report.unresolved).toBe(true);
      expect(report.risk).toBe('unknown');
      expect(report.processes).toEqual(['HandleRunFailure', 'AuditTask']);
      const context = await container.codeIntelligence!.getSymbolContext({ symbol: 'x' });
      expect(context.processes).toEqual(['HandleRunFailure', 'AuditTask']);
      const changeset = await container.codeIntelligence!.detectChanges({ worktree: root });
      expect(changeset.processes).toEqual(['HandleRunFailure', 'AuditTask']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves the stored agent adapter before Linear assignment comments', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-linear-adapter-'));
    const prevKey = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = 'lin_test_wrap';
    const seen: string[] = [];
    const { LinearIssueTracker } = await import('../../../src/infrastructure/integrations/linear/linear-issue-tracker.js');
    const original = LinearIssueTracker.prototype.onTaskAssigned;
    LinearIssueTracker.prototype.onTaskAssigned = async (_task, agent) => {
      seen.push(agent.adapter);
    };
    try {
      await mkdir(path.join(root, '.orchestry'), { recursive: true });
      await mkdir(path.join(root, '.orch'), { recursive: true });
      await writeFile(
        path.join(root, '.orch', 'workflow.yml'),
        ['version: 1', 'linear:', '  enabled: true', '  required_before_dispatch: true', ''].join('\n'),
        'utf8',
      );
      const { buildFullContainer } = await import('../../../src/container.js');
      const container = await buildFullContainer({
        projectRoot: root,
        json: false,
        quiet: true,
        noColor: true,
        ascii: true,
      });
      const agent = makeAgent({ id: 'agt_cursor', name: 'cursor-agent', adapter: 'cursor', status: 'idle' });
      await container.agentStore.save(agent);
      const task = makeTask({
        id: 'tsk_lin_assign',
        status: 'in_progress',
        assignee: agent.id,
        workspace: root,
        external: { linear: { id: 'iss_1', identifier: 'KON-1' } },
      });
      await container.taskStore.save(task);
      container.eventBus.emit({ type: 'task:assigned', taskId: task.id, agentId: agent.id });
      await vi.waitFor(() => {
        expect(seen).toEqual(['cursor']);
      });
    } finally {
      LinearIssueTracker.prototype.onTaskAssigned = original;
      if (prevKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = prevKey;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses merge-back when HEAD still has changes_requested even if a human approved', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-merge-review-'));
    try {
      await mkdir(path.join(root, '.orchestry'), { recursive: true });
      const { buildFullContainer } = await import('../../../src/container.js');
      const container = await buildFullContainer({
        projectRoot: root,
        json: false,
        quiet: true,
        noColor: true,
        ascii: true,
      });
      const task = makeTask({
        id: 'tsk_merge_block',
        status: 'review',
        proof: { branch: 'orch/tsk_merge_block', head_sha: 'abc123', files_changed: [] },
        reviews: [
          {
            reviewer_type: 'cursor',
            reviewer: 'cursor-cli',
            commit_sha: 'abc123',
            verdict: 'changes_requested',
            summary: 'gaps',
            timestamp: 't',
          },
          {
            reviewer_type: 'human',
            reviewer: 'alice',
            commit_sha: 'abc123',
            verdict: 'approve',
            summary: 'ok',
            timestamp: 't',
          },
        ],
      });
      await container.taskStore.save(task);
      const result = await container.workspaceManager.mergeBack('orch/tsk_merge_block');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.conflictInfo).toMatch(/REVIEW BLOCKED/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('light-container admission audits the task branch, not just HEAD', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-light-admit-'));
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      await execFileAsync('git', ['init'], { cwd: root });
      await execFileAsync('git', ['config', 'user.email', 't@t.test'], { cwd: root });
      await execFileAsync('git', ['config', 'user.name', 't'], { cwd: root });
      await writeFile(path.join(root, 'README.md'), 'x\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: root });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: root });
      const { stdout: baseShaOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
      const { stdout: defaultBranchOut } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
      await execFileAsync('git', ['checkout', '-b', 'orch/tsk_light_git'], { cwd: root });
      await mkdir(path.join(root, 'src'), { recursive: true });
      await writeFile(path.join(root, 'src', 'created.ts'), 'export const created = 1;\n');
      await execFileAsync('git', ['add', 'src/created.ts'], { cwd: root });
      await execFileAsync('git', ['commit', '-m', 'add file'], { cwd: root });
      await execFileAsync('git', ['checkout', defaultBranchOut.trim()], { cwd: root });
      await mkdir(path.join(root, '.orchestry'), { recursive: true });
      await mkdir(path.join(root, '.orch'), { recursive: true });
      await writeFile(
        path.join(root, '.orch', 'workflow.yml'),
        ['version: 1', 'code_admission:', '  enabled: true', ''].join('\n'),
        'utf8',
      );
      const { buildLightContainer } = await import('../../../src/container.js');
      const container = await buildLightContainer({
        projectRoot: root,
        json: false,
        quiet: true,
        noColor: true,
        ascii: true,
      });
      await container.admissionStore.saveContract({
        version: 1,
        task_id: 'tsk_light_git',
        base_sha: baseShaOut.trim(),
        source: 'fast_path',
        code_index: {
          provider: 'gitnexus',
          repo: 'test',
          index_commit: baseShaOut.trim(),
          index_current: true,
          generated_at: 't',
        },
        existing_code_considered: [],
        allowed_existing_edits: [],
        allowed_new_symbols: [],
        allowed_new_files: [],
        allowed_dependencies: [],
        status: 'approved',
      });
      const task = makeTask({
        id: 'tsk_light_git',
        status: 'review',
        proof: { branch: 'orch/tsk_light_git', head_sha: 'abc123', files_changed: [] },
      });
      await container.taskStore.save(task);
      const audit = await container.codeAdmissionService.auditTask(task);
      expect(audit.passed).toBe(false);
      expect(audit.violations.some((item) => item.kind === 'unapproved_file')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('orch proof binds SHA to the task branch, not checkout HEAD', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-proof-branch-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      await execFileAsync('git', ['init'], { cwd: root });
      await execFileAsync('git', ['config', 'user.email', 't@t.test'], { cwd: root });
      await execFileAsync('git', ['config', 'user.name', 't'], { cwd: root });
      await writeFile(path.join(root, 'README.md'), 'x\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: root });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: root });
      const { stdout: mainShaOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
      const { stdout: defaultBranchOut } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
      await execFileAsync('git', ['checkout', '-b', 'orch/tsk_proof_branch'], { cwd: root });
      await writeFile(path.join(root, 'README.md'), 'y\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: root });
      await execFileAsync('git', ['commit', '-m', 'task'], { cwd: root });
      const { stdout: branchShaOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
      await execFileAsync('git', ['checkout', defaultBranchOut.trim()], { cwd: root });
      await mkdir(path.join(root, '.orchestry'), { recursive: true });
      const { buildLightContainer } = await import('../../../src/container.js');
      const container = await buildLightContainer({
        projectRoot: root,
        json: false,
        quiet: true,
        noColor: true,
        ascii: true,
      });
      const task = makeTask({
        id: 'tsk_proof_branch',
        status: 'review',
        proof: { branch: 'orch/tsk_proof_branch', files_changed: [] },
      });
      await container.taskStore.save(task);
      const { Command } = await import('commander');
      const { registerProofCommand } = await import('../../../src/cli/commands/proof.js');
      const program = new Command();
      registerProofCommand(program, container);
      await program.parseAsync(['proof', 'show', 'tsk_proof_branch'], { from: 'user' });
      const saved = await container.taskStore.get('tsk_proof_branch');
      expect(saved?.proof?.head_sha).toBe(branchShaOut.trim());
      expect(saved?.proof?.head_sha).not.toBe(mainShaOut.trim());
    } finally {
      log.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recordReview binds a checkout-HEAD approve to the task branch SHA', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-review-branch-'));
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      await execFileAsync('git', ['init'], { cwd: root });
      await execFileAsync('git', ['config', 'user.email', 't@t.test'], { cwd: root });
      await execFileAsync('git', ['config', 'user.name', 't'], { cwd: root });
      await writeFile(path.join(root, 'README.md'), 'x\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: root });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: root });
      const { stdout: mainShaOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
      const { stdout: defaultBranchOut } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
      await execFileAsync('git', ['checkout', '-b', 'orch/tsk_review_branch'], { cwd: root });
      await writeFile(path.join(root, 'README.md'), 'y\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: root });
      await execFileAsync('git', ['commit', '-m', 'task'], { cwd: root });
      const { stdout: branchShaOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
      await execFileAsync('git', ['checkout', defaultBranchOut.trim()], { cwd: root });
      await mkdir(path.join(root, '.orchestry'), { recursive: true });
      const { buildLightContainer } = await import('../../../src/container.js');
      const container = await buildLightContainer({
        projectRoot: root,
        json: false,
        quiet: true,
        noColor: true,
        ascii: true,
      });
      const task = makeTask({
        id: 'tsk_review_branch',
        status: 'review',
        proof: { branch: 'orch/tsk_review_branch', files_changed: [] },
      });
      await container.taskStore.save(task);
      await container.integrationService.recordReview(task, {
        reviewer_type: 'human',
        reviewer: 'orch-cli',
        commit_sha: mainShaOut.trim(),
        verdict: 'approve',
        summary: 'Approved via orch task approve',
        timestamp: 't',
      });
      const saved = await container.taskStore.get('tsk_review_branch');
      expect(saved?.reviews?.[0]?.commit_sha).toBe(branchShaOut.trim());
      expect(saved?.reviews?.[0]?.commit_sha).not.toBe(mainShaOut.trim());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('orch pr link stamps the task branch SHA before Linear/GitHub proof', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-pr-link-sha-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      await execFileAsync('git', ['init'], { cwd: root });
      await execFileAsync('git', ['config', 'user.email', 't@t.test'], { cwd: root });
      await execFileAsync('git', ['config', 'user.name', 't'], { cwd: root });
      await writeFile(path.join(root, 'README.md'), 'x\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: root });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: root });
      const { stdout: mainShaOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
      const { stdout: defaultBranchOut } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
      await execFileAsync('git', ['checkout', '-b', 'orch/tsk_pr_link'], { cwd: root });
      await writeFile(path.join(root, 'README.md'), 'y\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: root });
      await execFileAsync('git', ['commit', '-m', 'task'], { cwd: root });
      const { stdout: branchShaOut } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
      await execFileAsync('git', ['checkout', defaultBranchOut.trim()], { cwd: root });
      await mkdir(path.join(root, '.orchestry'), { recursive: true });
      const { buildLightContainer } = await import('../../../src/container.js');
      const container = await buildLightContainer({
        projectRoot: root,
        json: false,
        quiet: true,
        noColor: true,
        ascii: true,
      });
      const task = makeTask({
        id: 'tsk_pr_link',
        status: 'review',
        proof: { branch: 'orch/tsk_pr_link', files_changed: [] },
      });
      await container.taskStore.save(task);
      const { Command } = await import('commander');
      const { registerPrCommand } = await import('../../../src/cli/commands/pr.js');
      const program = new Command();
      registerPrCommand(program, container);
      await program.parseAsync(['pr', 'link', 'tsk_pr_link', 'https://github.com/o/r/pull/9'], { from: 'user' });
      const saved = await container.taskStore.get('tsk_pr_link');
      expect(saved?.proof?.head_sha).toBe(branchShaOut.trim());
      expect(saved?.proof?.head_sha).not.toBe(mainShaOut.trim());
      expect(saved?.external?.github?.pr_url).toBe('https://github.com/o/r/pull/9');
    } finally {
      log.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('orch proof lints conventions on the task branch when checkout is elsewhere', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-proof-conv-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      await execFileAsync('git', ['init'], { cwd: root });
      await execFileAsync('git', ['config', 'user.email', 't@t.test'], { cwd: root });
      await execFileAsync('git', ['config', 'user.name', 't'], { cwd: root });
      await writeFile(path.join(root, 'README.md'), 'x\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: root });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: root });
      const { stdout: defaultBranchOut } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
      await execFileAsync('git', ['checkout', '-b', 'orch/tsk_proof_conv'], { cwd: root });
      await mkdir(path.join(root, 'src'), { recursive: true });
      await writeFile(path.join(root, 'src', 'created.ts'), 'export const created = 1;\n');
      await execFileAsync('git', ['add', 'src/created.ts'], { cwd: root });
      await execFileAsync('git', ['commit', '-m', 'add file'], { cwd: root });
      await execFileAsync('git', ['checkout', defaultBranchOut.trim()], { cwd: root });
      await mkdir(path.join(root, '.orchestry'), { recursive: true });
      await mkdir(path.join(root, '.orch'), { recursive: true });
      await writeFile(
        path.join(root, '.orch', 'workflow.yml'),
        ['version: 1', 'conventions:', '  enabled: true', ''].join('\n'),
        'utf8',
      );
      const { buildLightContainer } = await import('../../../src/container.js');
      const container = await buildLightContainer({
        projectRoot: root,
        json: false,
        quiet: true,
        noColor: true,
        ascii: true,
      });
      const task = makeTask({
        id: 'tsk_proof_conv',
        status: 'review',
        proof: { branch: 'orch/tsk_proof_conv', files_changed: [] },
      });
      await container.taskStore.save(task);
      const { Command } = await import('commander');
      const { registerProofCommand } = await import('../../../src/cli/commands/proof.js');
      const program = new Command();
      registerProofCommand(program, container);
      await program.parseAsync(['proof', 'show', 'tsk_proof_conv'], { from: 'user' });
      const saved = await container.taskStore.get('tsk_proof_conv');
      expect(saved?.proof?.head_sha).toBeTruthy();
      const snap = JSON.parse(
        await (await import('node:fs/promises')).readFile(
          path.join(root, '.orchestry', 'proofs', 'tsk_proof_conv', `${saved?.proof?.head_sha}.json`),
          'utf8',
        ),
      ) as { checks: Array<{ name: string; status: string; summary?: string }> };
      const convention = snap.checks.find((check) => check.name === 'conventions');
      expect(convention?.status).toBe('failed');
      expect(convention?.summary).toMatch(/header|created\.ts/);
    } finally {
      log.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses merge-back when admission or conventions audit fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-merge-admit-'));
    try {
      await mkdir(path.join(root, '.orchestry'), { recursive: true });
      await mkdir(path.join(root, '.orch'), { recursive: true });
      await writeFile(
        path.join(root, '.orch', 'workflow.yml'),
        ['version: 1', 'code_admission:', '  enabled: true', 'conventions:', '  enabled: true', ''].join('\n'),
        'utf8',
      );
      const { buildFullContainer } = await import('../../../src/container.js');
      const container = await buildFullContainer({
        projectRoot: root,
        json: false,
        quiet: true,
        noColor: true,
        ascii: true,
      });
      const task = makeTask({
        id: 'tsk_merge_admit',
        status: 'review',
        proof: { branch: 'orch/tsk_merge_admit', head_sha: 'abc123', files_changed: [] },
      });
      await container.taskStore.save(task);
      const result = await container.workspaceManager.mergeBack('orch/tsk_merge_admit');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.conflictInfo).toMatch(/ADMISSION BLOCKED/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses merge-back when MEDIUM impact edits have no dependent tests', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-merge-medium-'));
    try {
      await mkdir(path.join(root, '.orchestry'), { recursive: true });
      await mkdir(path.join(root, '.orch'), { recursive: true });
      await writeFile(
        path.join(root, '.orch', 'workflow.yml'),
        ['version: 1', 'code_admission:', '  enabled: true', ''].join('\n'),
        'utf8',
      );
      const { AdmissionStore } = await import('../../../src/infrastructure/storage/admission-store.js');
      const { Paths } = await import('../../../src/infrastructure/storage/paths.js');
      await new AdmissionStore(new Paths(root)).saveContract({
        version: 1,
        task_id: 'tsk_merge_medium',
        base_sha: 'abc123',
        source: 'planned',
        status: 'approved',
        code_index: {
          provider: 'gitnexus',
          repo: 'ORCH',
          index_commit: 'abc123',
          index_current: true,
          generated_at: '2026-01-01T00:00:00Z',
        },
        existing_code_considered: [{
          path: 'src/retry.ts',
          symbol: 'retry',
          relevance: 'high',
          decision: 'modify',
          reason: 'GitNexus hit for "retry" (impact MEDIUM, 4 dependents, processes: RetryFlow)',
        }],
        allowed_existing_edits: [{
          symbol: 'retry',
          path: 'src/retry.ts',
          expected_change: 'edit',
          impact: { risk: 'medium', total_dependents: 4 },
        }],
        allowed_new_symbols: [],
        allowed_new_files: [],
        allowed_dependencies: [],
      });
      const { buildFullContainer } = await import('../../../src/container.js');
      const container = await buildFullContainer({
        projectRoot: root,
        json: false,
        quiet: true,
        noColor: true,
        ascii: true,
      });
      const task = makeTask({
        id: 'tsk_merge_medium',
        status: 'review',
        proof: { branch: 'orch/tsk_merge_medium', head_sha: 'abc123', files_changed: [] },
      });
      await container.taskStore.save(task);
      const result = await container.workspaceManager.mergeBack('orch/tsk_merge_medium');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.conflictInfo).toMatch(/MEDIUM impact edits require tests/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses merge-back when branch HEAD moved past the verified SHA', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-merge-stale-'));
    try {
      await mkdir(path.join(root, '.orchestry'), { recursive: true });
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      await execFileAsync('git', ['init'], { cwd: root });
      await execFileAsync('git', ['config', 'user.email', 't@t.test'], { cwd: root });
      await execFileAsync('git', ['config', 'user.name', 't'], { cwd: root });
      await writeFile(path.join(root, 'README.md'), 'x\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: root });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: root });
      await execFileAsync('git', ['branch', 'orch/tsk_stale'], { cwd: root });
      const { buildFullContainer } = await import('../../../src/container.js');
      const container = await buildFullContainer({
        projectRoot: root,
        json: false,
        quiet: true,
        noColor: true,
        ascii: true,
      });
      const task = makeTask({
        id: 'tsk_stale',
        status: 'review',
        proof: {
          branch: 'orch/tsk_stale',
          head_sha: 'deadbeef',
          files_changed: [],
          verified: true,
        },
      });
      await container.taskStore.save(task);
      const result = await container.workspaceManager.mergeBack('orch/tsk_stale');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.conflictInfo).toMatch(/PROOF STALE/);
      }
      const stored = await container.taskStore.get(task.id);
      expect(stored?.proof?.verified).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('clears stored Verified on a watcher tick after the branch moved', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-tick-stale-'));
    try {
      await mkdir(path.join(root, '.orchestry'), { recursive: true });
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      await execFileAsync('git', ['init'], { cwd: root });
      await execFileAsync('git', ['config', 'user.email', 't@t.test'], { cwd: root });
      await execFileAsync('git', ['config', 'user.name', 't'], { cwd: root });
      await writeFile(path.join(root, 'README.md'), 'x\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: root });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: root });
      await execFileAsync('git', ['branch', 'orch/tsk_tick_stale'], { cwd: root });
      const { buildFullContainer } = await import('../../../src/container.js');
      const container = await buildFullContainer({
        projectRoot: root,
        json: false,
        quiet: true,
        noColor: true,
        ascii: true,
      });
      await container.taskStore.save(makeTask({
        id: 'tsk_tick_stale',
        status: 'review',
        workspace: root,
        proof: {
          branch: 'orch/tsk_tick_stale',
          head_sha: 'deadbeef',
          files_changed: [],
          verified: true,
        },
      }));
      container.eventBus.emit({ type: 'orchestrator:tick', running: 0, queued: 0 });
      await vi.waitFor(async () => {
        const stored = await container.taskStore.get('tsk_tick_stale');
        expect(stored?.proof?.verified).toBe(false);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('drops Linear Verified when branch HEAD moved past the proof SHA', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-proof-stale-'));
    const prevKey = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = 'lin_test_stale_proof';
    const seen: boolean[] = [];
    const { LinearIssueTracker } = await import('../../../src/infrastructure/integrations/linear/linear-issue-tracker.js');
    const original = LinearIssueTracker.prototype.publishEvidence;
    LinearIssueTracker.prototype.publishEvidence = async (_task, evidence) => {
      seen.push(evidence.verified);
    };
    try {
      await mkdir(path.join(root, '.orchestry'), { recursive: true });
      await mkdir(path.join(root, '.orch'), { recursive: true });
      await writeFile(
        path.join(root, '.orch', 'workflow.yml'),
        ['version: 1', 'linear:', '  enabled: true', ''].join('\n'),
        'utf8',
      );
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      await execFileAsync('git', ['init'], { cwd: root });
      await execFileAsync('git', ['config', 'user.email', 't@t.test'], { cwd: root });
      await execFileAsync('git', ['config', 'user.name', 't'], { cwd: root });
      await writeFile(path.join(root, 'README.md'), 'x\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: root });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: root });
      await execFileAsync('git', ['branch', 'orch/tsk_stale_proof'], { cwd: root });
      const { buildFullContainer } = await import('../../../src/container.js');
      const container = await buildFullContainer({
        projectRoot: root,
        json: false,
        quiet: true,
        noColor: true,
        ascii: true,
      });
      const task = makeTask({
        id: 'tsk_stale_proof',
        status: 'review',
        workspace: root,
        proof: {
          branch: 'orch/tsk_stale_proof',
          head_sha: 'deadbeef',
          files_changed: [],
          verified: true,
        },
      });
      await container.taskStore.save(task);
      await container.integrationService.publishProof(task, {
        task_id: task.id,
        head_sha: 'deadbeef',
        files_changed: [],
        checks: [],
        reviews: [],
        acceptance_criteria: [],
        verified: true,
      });
      expect(seen).toEqual([false]);
      const stored = await container.taskStore.get(task.id);
      expect(stored?.proof?.verified).toBe(false);
    } finally {
      LinearIssueTracker.prototype.publishEvidence = original;
      if (prevKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = prevKey;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stamps GitNexus admission onto a SHA-only proof publish', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-proof-admission-'));
    const prevKey = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = 'lin_test_proof_admission';
    const seen: Array<{
      existing_candidates?: number;
      reused_symbols?: string[];
      approved_new_files?: string[];
      repo?: string;
      worktree?: string;
      provider?: string;
    }> = [];
    const { LinearIssueTracker } = await import('../../../src/infrastructure/integrations/linear/linear-issue-tracker.js');
    const original = LinearIssueTracker.prototype.publishEvidence;
    LinearIssueTracker.prototype.publishEvidence = async (_task, evidence) => {
      seen.push(evidence.admission as typeof seen[number]);
    };
    try {
      await mkdir(path.join(root, '.orchestry'), { recursive: true });
      await mkdir(path.join(root, '.orch'), { recursive: true });
      await writeFile(
        path.join(root, '.orch', 'workflow.yml'),
        ['version: 1', 'linear:', '  enabled: true', ''].join('\n'),
        'utf8',
      );
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      await execFileAsync('git', ['init'], { cwd: root });
      await execFileAsync('git', ['config', 'user.email', 't@t.test'], { cwd: root });
      await execFileAsync('git', ['config', 'user.name', 't'], { cwd: root });
      await writeFile(path.join(root, 'README.md'), 'x\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: root });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: root });
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
      const sha = stdout.trim();
      const { AdmissionStore } = await import('../../../src/infrastructure/storage/admission-store.js');
      const { Paths } = await import('../../../src/infrastructure/storage/paths.js');
      await new AdmissionStore(new Paths(root)).saveContract({
        version: 1,
        task_id: 'tsk_proof_adm',
        base_sha: sha,
        source: 'planned',
        status: 'approved',
        code_index: {
          provider: 'gitnexus',
          repo: 'ORCH',
          index_commit: 'c0ffee1',
          index_current: true,
          generated_at: '2026-01-01T00:00:00Z',
        },
        existing_code_considered: [{
          path: 'src/retry.ts',
          symbol: 'retry',
          relevance: 'high',
          decision: 'reuse',
          reason: 'existing helper',
        }],
        allowed_existing_edits: [],
        allowed_new_symbols: [],
        allowed_new_files: [{
          path: 'src/new-retry.ts',
          reason: 'boundary',
          why_existing_files_are_not_suitable: 'different owner',
          approved_by: 'council',
          approved_at: '2026-01-01T00:00:00Z',
        }],
        allowed_dependencies: [],
      });
      const { buildFullContainer } = await import('../../../src/container.js');
      const container = await buildFullContainer({
        projectRoot: root,
        json: false,
        quiet: true,
        noColor: true,
        ascii: true,
      });
      const task = makeTask({
        id: 'tsk_proof_adm',
        status: 'review',
        workspace: root,
        proof: { branch: 'HEAD', head_sha: sha, files_changed: [], verified: true },
        feedback: 'admission: processes: RetryFlow',
        external: { linear: { id: 'iss_1', identifier: 'KON-1' } },
      });
      await container.taskStore.save(task);
      await container.integrationService.publishProof(task, {
        task_id: task.id,
        head_sha: sha,
        files_changed: [],
        checks: [],
        reviews: [],
        acceptance_criteria: [],
        verified: true,
      });
      expect(seen[0]?.provider).toBe('gitnexus');
      expect(seen[0]?.repo).toBe('ORCH');
      expect(seen[0]?.worktree).toBe(root);
      expect(seen[0]?.existing_candidates).toBe(1);
      expect(seen[0]?.reused_symbols).toEqual(['retry']);
      expect(seen[0]?.approved_new_files).toEqual(['src/new-retry.ts']);
      expect((seen[0] as { affected_processes?: string[] })?.affected_processes).toEqual(['RetryFlow']);
    } finally {
      LinearIssueTracker.prototype.publishEvidence = original;
      if (prevKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = prevKey;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('drops Verified when MEDIUM impact edits have no dependent tests', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-proof-medium-'));
    const prevKey = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = 'lin_test_medium_tests';
    const seen: Array<{ verified: boolean; violations?: string[] }> = [];
    const { LinearIssueTracker } = await import('../../../src/infrastructure/integrations/linear/linear-issue-tracker.js');
    const original = LinearIssueTracker.prototype.publishEvidence;
    LinearIssueTracker.prototype.publishEvidence = async (_task, evidence) => {
      seen.push({
        verified: evidence.verified,
        violations: evidence.admission?.violations,
      });
    };
    try {
      await mkdir(path.join(root, '.orchestry'), { recursive: true });
      await mkdir(path.join(root, '.orch'), { recursive: true });
      await writeFile(
        path.join(root, '.orch', 'workflow.yml'),
        ['version: 1', 'linear:', '  enabled: true', ''].join('\n'),
        'utf8',
      );
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      await execFileAsync('git', ['init'], { cwd: root });
      await execFileAsync('git', ['config', 'user.email', 't@t.test'], { cwd: root });
      await execFileAsync('git', ['config', 'user.name', 't'], { cwd: root });
      await writeFile(path.join(root, 'README.md'), 'x\n');
      await execFileAsync('git', ['add', 'README.md'], { cwd: root });
      await execFileAsync('git', ['commit', '-m', 'init'], { cwd: root });
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root });
      const sha = stdout.trim();
      const { AdmissionStore } = await import('../../../src/infrastructure/storage/admission-store.js');
      const { Paths } = await import('../../../src/infrastructure/storage/paths.js');
      await new AdmissionStore(new Paths(root)).saveContract({
        version: 1,
        task_id: 'tsk_medium',
        base_sha: sha,
        source: 'planned',
        status: 'approved',
        code_index: {
          provider: 'gitnexus',
          repo: 'ORCH',
          index_commit: sha,
          index_current: true,
          generated_at: '2026-01-01T00:00:00Z',
        },
        existing_code_considered: [{
          path: 'src/retry.ts',
          symbol: 'retry',
          relevance: 'high',
          decision: 'modify',
          reason: 'GitNexus hit for "retry" (impact MEDIUM, 4 dependents, processes: RetryFlow)',
        }],
        allowed_existing_edits: [{
          symbol: 'retry',
          path: 'src/retry.ts',
          expected_change: 'edit',
          impact: { risk: 'medium', total_dependents: 4 },
        }],
        allowed_new_symbols: [],
        allowed_new_files: [],
        allowed_dependencies: [],
      });
      const { buildFullContainer } = await import('../../../src/container.js');
      const container = await buildFullContainer({
        projectRoot: root,
        json: false,
        quiet: true,
        noColor: true,
        ascii: true,
      });
      const task = makeTask({
        id: 'tsk_medium',
        status: 'review',
        workspace: root,
        proof: { branch: 'HEAD', head_sha: sha, files_changed: [], verified: true },
        external: { linear: { id: 'iss_1', identifier: 'KON-1' } },
      });
      await container.taskStore.save(task);
      await container.integrationService.publishProof(task, {
        task_id: task.id,
        head_sha: sha,
        files_changed: [],
        checks: [],
        reviews: [],
        acceptance_criteria: [],
        verified: true,
      });
      expect(seen[0]?.verified).toBe(false);
      expect(seen[0]?.violations?.some((item) => /MEDIUM impact edits require tests/i.test(item))).toBe(true);
    } finally {
      LinearIssueTracker.prototype.publishEvidence = original;
      if (prevKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = prevKey;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retries tasks that never got a Linear outbox after login', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-linear-backfill-'));
    const prevKey = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = 'lin_test_backfill';
    const seen: string[] = [];
    const { IntegrationService } = await import('../../../src/application/integration-service.js');
    const original = IntegrationService.prototype.retry;
    IntegrationService.prototype.retry = async function(taskId: string) {
      seen.push(taskId);
      return { id: taskId } as Task;
    };
    try {
      await mkdir(path.join(root, '.orchestry'), { recursive: true });
      await mkdir(path.join(root, '.orch'), { recursive: true });
      await writeFile(
        path.join(root, '.orch', 'workflow.yml'),
        ['version: 1', 'linear:', '  enabled: true', '  required_before_dispatch: true', ''].join('\n'),
        'utf8',
      );
      const { buildFullContainer } = await import('../../../src/container.js');
      const container = await buildFullContainer({
        projectRoot: root,
        json: false,
        quiet: true,
        noColor: true,
        ascii: true,
      });
      const missing = makeTask({ id: 'tsk_lin_missing', status: 'todo', workspace: root });
      const cancelled = makeTask({ id: 'tsk_lin_cancelled', status: 'cancelled', workspace: root });
      const linked = makeTask({
        id: 'tsk_lin_linked',
        status: 'todo',
        workspace: root,
        external: { linear: { id: 'iss_1', identifier: 'KON-1' } },
      });
      await container.taskStore.save(missing);
      await container.taskStore.save(cancelled);
      await container.taskStore.save(linked);
      container.eventBus.emit({ type: 'orchestrator:tick', running: 0, queued: 0 });
      await vi.waitFor(() => {
        expect(seen).toContain('tsk_lin_missing');
      });
      expect(seen).not.toContain('tsk_lin_cancelled');
      expect(seen).not.toContain('tsk_lin_linked');
    } finally {
      IntegrationService.prototype.retry = original;
      if (prevKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = prevKey;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retries existing tasks with no Linear outbox when a logged-in process starts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-linear-start-'));
    const prevKey = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = 'lin_test_start';
    const seen: string[] = [];
    const { IntegrationService } = await import('../../../src/application/integration-service.js');
    const original = IntegrationService.prototype.retry;
    IntegrationService.prototype.retry = async function(taskId: string) {
      seen.push(taskId);
      return { id: taskId } as Task;
    };
    try {
      await mkdir(path.join(root, '.orchestry'), { recursive: true });
      await mkdir(path.join(root, '.orch'), { recursive: true });
      await writeFile(
        path.join(root, '.orch', 'workflow.yml'),
        ['version: 1', 'linear:', '  enabled: true', '  required_before_dispatch: true', ''].join('\n'),
        'utf8',
      );
      const { Paths } = await import('../../../src/infrastructure/storage/paths.js');
      const { TaskStore } = await import('../../../src/infrastructure/storage/task-store.js');
      const store = new TaskStore(new Paths(root));
      await store.save(makeTask({ id: 'tsk_lin_startup', status: 'todo', workspace: root }));
      await store.save(makeTask({ id: 'tsk_lin_startup_cancelled', status: 'cancelled', workspace: root }));
      const { buildLightContainer } = await import('../../../src/container.js');
      await buildLightContainer({
        projectRoot: root,
        json: false,
        quiet: true,
        noColor: true,
        ascii: true,
      });
      await vi.waitFor(() => {
        expect(seen).toContain('tsk_lin_startup');
      });
      expect(seen).not.toContain('tsk_lin_startup_cancelled');
    } finally {
      IntegrationService.prototype.retry = original;
      if (prevKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = prevKey;
      await rm(root, { recursive: true, force: true });
    }
  });
});
