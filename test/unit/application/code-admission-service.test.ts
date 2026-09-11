import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventBus } from '../../../src/application/event-bus.js';
import { CodeAdmissionService } from '../../../src/application/code-admission-service.js';
import { AdmissionStore } from '../../../src/infrastructure/storage/admission-store.js';
import { Paths } from '../../../src/infrastructure/storage/paths.js';
import { DEFAULT_WORKFLOW_CONFIG, type WorkflowConfig } from '../../../src/domain/workflow-config.js';
import type { ICodeIntelligence } from '../../../src/infrastructure/code-intelligence/interface.js';
import type { SemanticChangeSet } from '../../../src/domain/code-intelligence.js';
import { createMockTaskStore, makeTask } from './helpers.js';

const execFileAsync = promisify(execFile);

const enabledWorkflow: WorkflowConfig = {
  ...DEFAULT_WORKFLOW_CONFIG,
  code_admission: {
    ...DEFAULT_WORKFLOW_CONFIG.code_admission,
    enabled: true,
  },
};

function mockIntelligence(overrides: Partial<ICodeIntelligence> = {}): ICodeIntelligence {
  return {
    getRepositoryStatus: async () => ({
      provider: 'gitnexus',
      repo: 'test',
      available: true,
      current: true,
      index_commit: 'abc123',
      incomplete_reasons: [],
    }),
    searchExisting: async () => [],
    getSymbolContext: async () => ({ symbol: 'x', callers: [], callees: [], processes: [] }),
    getImpact: async () => ({
      target: 'x',
      risk: 'low',
      direct_dependents: 0,
      total_dependents: 0,
      processes: [],
      unresolved: false,
    }),
    getProcesses: async () => [],
    detectChanges: async () => emptySemantic(),
    analyze: async () => {},
    ...overrides,
  };
}

function emptySemantic(overrides: Partial<SemanticChangeSet> = {}): SemanticChangeSet {
  return {
    added_symbols: [],
    modified_symbols: [],
    deleted_symbols: [],
    processes: [],
    risk: 'low',
    partial: false,
    truncated: false,
    degraded: false,
    worktree: '',
    ...overrides,
  };
}

describe('CodeAdmissionService', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'orch-adm-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  function setup(intelligence?: ICodeIntelligence, workflow: WorkflowConfig | null = enabledWorkflow) {
    const paths = new Paths(root);
    const store = new AdmissionStore(paths);
    const taskA = makeTask({ id: 'tsk_aaa', status: 'in_progress', workspace: path.join(root, 'wt-a') });
    const taskB = makeTask({ id: 'tsk_bbb', status: 'in_progress', workspace: path.join(root, 'wt-b') });
    const taskStore = createMockTaskStore([taskA, taskB]);
    const service = new CodeAdmissionService(
      store,
      taskStore,
      new EventBus(),
      workflow,
      root,
      intelligence,
      {
        prepare: async () => ({ path: root }),
        mergeBack: async () => ({ success: true as const }),
        cleanup: async () => {},
        validate: () => {},
        getChangedFiles: async () => [],
        getChangedFileDiffs: async () => [],
      },
    );
    return { service, store, taskStore, taskA, taskB };
  }

  it('skips when workflow is missing', async () => {
    const { service, taskA } = setup(undefined, null);
    expect(service.enabled()).toBe(false);
    expect(await service.ensureFastPathContract(taskA)).toBeNull();
  });

  it('fast-path contract has zero creates', async () => {
    const { service, taskA } = setup();
    const contract = await service.ensureFastPathContract(taskA);
    expect(contract?.source).toBe('fast_path');
    expect(contract?.allowed_new_files).toEqual([]);
    expect(contract?.allowed_new_symbols).toEqual([]);
    expect(contract?.allowed_dependencies).toEqual([]);
  });

  it('prompt block includes worker GitNexus context', async () => {
    const { service, taskA } = setup();
    const contract = await service.ensureFastPathContract(taskA);
    expect(contract).toBeTruthy();
    const block = service.renderPromptBlock(contract!, '/tmp/orch-wt');
    expect(block).toContain('worktree_path: /tmp/orch-wt');
    expect(block).toContain('gitnexus.repo:');
    expect(block).toContain('gitnexus.index_commit:');
    expect(block).toContain('detect_changes');
  });

  it('strong exact symbol name auto-rejects without an LLM', async () => {
    const intelligence = mockIntelligence({
      searchExisting: async () => [{ path: 'src/application/orchestrator.ts', symbol: 'enqueueRetry' }],
    });
    const { service, taskA } = setup(intelligence);
    const request = await service.submitRequest({
      task_id: taskA.id,
      type: 'new_symbol',
      proposed: { name: 'enqueueRetry' },
    });
    expect(request.status).toBe('rejected');
    expect(request.decision?.decided_by).toBe('gitnexus');
    expect(request.decision?.redirect?.name).toBe('enqueueRetry');
  });

  it('exact GitNexus context hit auto-rejects even when search is empty', async () => {
    const intelligence = mockIntelligence({
      searchExisting: async () => [],
      getSymbolContext: async () => ({
        symbol: 'enqueueRetry',
        path: 'src/application/orchestrator.ts',
        callers: ['_handleRunFailure'],
        callees: [],
        processes: ['HandleRunFailure'],
      }),
    });
    const { service, taskA } = setup(intelligence);
    const request = await service.submitRequest({
      task_id: taskA.id,
      type: 'new_symbol',
      proposed: { name: 'enqueueRetry' },
    });
    expect(request.status).toBe('rejected');
    expect(request.decision?.decided_by).toBe('gitnexus');
  });

  it('does not treat a pathless context echo as a strong hit', async () => {
    const intelligence = mockIntelligence({
      searchExisting: async () => [],
      getSymbolContext: async () => ({
        symbol: 'BrandNewHelper',
        callers: [],
        callees: [],
        processes: [],
      }),
    });
    const { service, taskA } = setup(intelligence);
    const request = await service.submitRequest({
      task_id: taskA.id,
      type: 'new_symbol',
      proposed: { name: 'BrandNewHelper' },
      why_existing_file_is_not_enough: 'No current owner exports this helper',
    });
    expect(request.status).toBe('pending_llm');
  });

  it('strong exact path hit auto-rejects without approving', async () => {
    const intelligence = mockIntelligence({
      searchExisting: async () => [{ path: 'src/sync/retry.ts', symbol: 'retry' }],
    });
    const { service, taskA } = setup(intelligence);
    const request = await service.submitRequest({
      task_id: taskA.id,
      type: 'new_file',
      proposed: { path: 'src/sync/retry.ts' },
    });
    expect(request.status).toBe('rejected');
    expect(request.decision?.decided_by).toBe('gitnexus');
    expect(request.decision?.redirect?.path).toBe('src/sync/retry.ts');
  });

  it('redirects a reserved file and adds depends_on', async () => {
    const { service, store, taskStore, taskA, taskB } = setup();
    await store.addReservation({
      kind: 'file',
      path: 'src/new-retry.ts',
      task_id: taskA.id,
    });
    const request = await service.submitRequest({
      task_id: taskB.id,
      type: 'new_file',
      proposed: { path: 'src/new-retry.ts' },
    });
    expect(request.status).toBe('redirected');
    const updated = await taskStore.get(taskB.id);
    expect(updated?.depends_on).toContain(taskA.id);
  });

  it('duplicate request is idempotent', async () => {
    const { service, taskA } = setup();
    const first = await service.submitRequest({
      task_id: taskA.id,
      type: 'new_symbol',
      proposed: { name: 'foo', path: 'src/foo.ts' },
    });
    const second = await service.submitRequest({
      task_id: taskA.id,
      type: 'new_symbol',
      proposed: { name: 'foo', path: 'src/foo.ts' },
    });
    expect(second.id).toBe(first.id);
  });

  it('audit fails on unapproved new file', async () => {
    const { service, taskA } = setup();
    await service.ensureFastPathContract(taskA);
    const workspaceManager = {
      prepare: async () => ({ path: root }),
      mergeBack: async () => ({ success: true as const }),
      cleanup: async () => {},
      validate: () => {},
      getChangedFiles: async () => ['src/invented.ts'],
      getChangedFileDiffs: async () => [{ path: 'src/invented.ts', status: 'added' as const, addedLines: ['export const x = 1'] }],
    };
    const paths = new Paths(root);
    const audited = new CodeAdmissionService(
      new AdmissionStore(paths),
      createMockTaskStore([taskA]),
      new EventBus(),
      enabledWorkflow,
      root,
      mockIntelligence(),
      workspaceManager,
    );
    await audited.ensureFastPathContract(taskA);
    const result = await audited.auditTask({ ...taskA, proof: { branch: 'orch/tsk_aaa', files_changed: [] } });
    expect(result.passed).toBe(false);
    expect(result.violations.some((item) => item.kind === 'unapproved_file')).toBe(true);
  });

  it('audit passes an approved new file', async () => {
    const workspaceManager = {
      prepare: async () => ({ path: root }),
      mergeBack: async () => ({ success: true as const }),
      cleanup: async () => {},
      validate: () => {},
      getChangedFiles: async () => ['src/allowed.ts'],
      getChangedFileDiffs: async () => [{ path: 'src/allowed.ts', status: 'added' as const, addedLines: [] }],
    };
    const paths = new Paths(root);
    const task = makeTask({ id: 'tsk_ccc', status: 'in_progress', proof: { branch: 'orch/tsk_ccc', files_changed: [] } });
    const service = new CodeAdmissionService(
      new AdmissionStore(paths),
      createMockTaskStore([task]),
      new EventBus(),
      enabledWorkflow,
      root,
      mockIntelligence({ detectChanges: async () => emptySemantic() }),
      workspaceManager,
    );
    await service.ensureFastPathContract(task);
    const request = await service.submitRequest({
      task_id: task.id,
      type: 'new_file',
      proposed: { path: 'src/allowed.ts' },
      why_existing_file_is_not_enough: 'New isolated adapter; existing modules own other boundaries.',
    });
    await service.approveRequest(request.id, 'test');
    const result = await service.auditTask(task);
    expect(result.passed).toBe(true);
  });

  it('plan reuse creates pre-authorize the contract', async () => {
    const { service, taskA } = setup();
    const contract = await service.applyReuseCreates(taskA, {
      searches: ['retry'],
      candidates: [],
      recommended_edits: [],
      proposed_creates: [
        { kind: 'file', path: 'src/retry-hook.ts', why_not_reuse: 'no existing hook' },
        { kind: 'symbol', name: 'useRetry', path: 'src/retry-hook.ts', why_not_reuse: 'new export' },
      ],
      incomplete: false,
      reasons: [],
    });
    expect(contract?.allowed_new_files.map((file) => file.path)).toContain('src/retry-hook.ts');
    expect(contract?.allowed_new_symbols.map((symbol) => symbol.name)).toContain('useRetry');
  });

  it('plan reuse authorizes a symbol create even without a path', async () => {
    const { service, taskA } = setup();
    const contract = await service.applyReuseCreates(taskA, {
      searches: ['brandNewHelper'],
      candidates: [],
      recommended_edits: [],
      proposed_creates: [
        { kind: 'symbol', name: 'brandNewHelper', why_not_reuse: 'no GitNexus hit' },
      ],
      incomplete: false,
      reasons: [],
    });
    expect(contract?.allowed_new_symbols.map((symbol) => symbol.name)).toContain('brandNewHelper');
  });

  it('rejects a security admission when PDG analyze is unavailable', async () => {
    const { service, taskA } = setup(mockIntelligence({
      analyze: undefined,
    }));
    const request = await service.submitRequest({
      task_id: taskA.id,
      type: 'new_file',
      proposed: { path: 'src/auth/session.ts' },
      need: 'auth session store',
      gitnexus_searches: ['auth session'],
    });
    expect(request.status).toBe('rejected');
    expect(request.decision?.reason).toMatch(/PDG required/i);
    expect(request.decision?.reason).not.toMatch(/analyze --pdg failed/i);
  });

  it('re-runs PDG when a pending_llm security request is retried', async () => {
    let failPdg = false;
    const intelligence = mockIntelligence({
      analyze: async () => {
        if (failPdg) throw new Error('oom');
      },
    });
    const { service, taskA } = setup(intelligence);
    const request = await service.submitRequest({
      task_id: taskA.id,
      type: 'new_file',
      proposed: { path: 'src/auth/new-session.ts' },
      need: 'auth session helper',
      why_existing_file_is_not_enough: 'No current owner exports this helper',
    });
    expect(request.status).toBe('pending_llm');
    failPdg = true;
    await service.processPending();
    const after = await service.getRequest(request.id);
    expect(after?.status).toBe('rejected');
    expect(after?.decision?.reason).toMatch(/analyze --pdg failed/i);
  });

  it('rejects a payments admission when PDG analyze fails', async () => {
    const { service, taskA } = setup(mockIntelligence({
      analyze: async () => {
        throw new Error('oom');
      },
    }));
    const request = await service.submitRequest({
      task_id: taskA.id,
      type: 'new_symbol',
      proposed: { name: 'chargeCard', path: 'src/billing/charge.ts' },
      need: 'payments charge helper',
    });
    expect(request.status).toBe('rejected');
    expect(request.decision?.reason).toMatch(/analyze --pdg failed/i);
  });

  it('unspecified impact rejects a high-risk edit (not treated as LOW)', async () => {
    const { service, taskA } = setup();
    const request = await service.submitRequest({
      task_id: taskA.id,
      type: 'high_risk_edit',
      proposed: { name: 'foo', path: 'src/x.ts' },
    });
    expect(request.status).toBe('rejected');
    expect(request.decision?.reason).toMatch(/UNKNOWN/i);
  });

  it('unknown impact rejects a create (not treated as LOW)', async () => {
    const { service, taskA } = setup(mockIntelligence({
      getImpact: async () => ({
        target: 'left-pad',
        risk: 'unknown',
        direct_dependents: 0,
        total_dependents: 0,
        processes: [],
        unresolved: true,
      }),
    }));
    const request = await service.submitRequest({
      task_id: taskA.id,
      type: 'new_dependency',
      proposed: { package: 'left-pad' },
    });
    expect(request.status).toBe('rejected');
    expect(request.decision?.reason).toMatch(/UNKNOWN/i);
  });

  it('stale GitNexus index fails the audit', async () => {
    const workspaceManager = {
      prepare: async () => ({ path: root }),
      mergeBack: async () => ({ success: true as const }),
      cleanup: async () => {},
      validate: () => {},
      getChangedFiles: async () => [],
      getChangedFileDiffs: async () => [],
    };
    const paths = new Paths(root);
    const task = makeTask({ id: 'tsk_stale', status: 'in_progress', proof: { branch: 'orch/tsk_stale', files_changed: [] } });
    const service = new CodeAdmissionService(
      new AdmissionStore(paths),
      createMockTaskStore([task]),
      new EventBus(),
      enabledWorkflow,
      root,
      mockIntelligence({
        getRepositoryStatus: async () => ({
          provider: 'gitnexus',
          repo: 'test',
          available: true,
          current: false,
          incomplete_reasons: ['index behind HEAD'],
        }),
      }),
      workspaceManager,
    );
    await service.ensureFastPathContract(task);
    const result = await service.auditTask(task);
    expect(result.passed).toBe(false);
    expect(result.incomplete).toBe(true);
  });

  it('partial GitNexus detect_changes fails closed', async () => {
    const workspaceManager = {
      prepare: async () => ({ path: root }),
      mergeBack: async () => ({ success: true as const }),
      cleanup: async () => {},
      validate: () => {},
      getChangedFiles: async () => [],
      getChangedFileDiffs: async () => [],
    };
    const paths = new Paths(root);
    const task = makeTask({ id: 'tsk_ddd', status: 'in_progress', proof: { branch: 'orch/tsk_ddd', files_changed: [] } });
    const service = new CodeAdmissionService(
      new AdmissionStore(paths),
      createMockTaskStore([task]),
      new EventBus(),
      enabledWorkflow,
      root,
      mockIntelligence({ detectChanges: async () => emptySemantic({ partial: true }) }),
      workspaceManager,
    );
    await service.ensureFastPathContract(task);
    const result = await service.auditTask(task);
    expect(result.passed).toBe(false);
    expect(result.incomplete).toBe(true);
  });

  it('points detect_changes at each task worktree and rejects a wrong-worktree result', async () => {
    const seen: string[] = [];
    const wtA = path.join(root, 'wt-a');
    const wtB = path.join(root, 'wt-b');
    const taskA = makeTask({
      id: 'tsk_wta',
      status: 'in_progress',
      workspace: wtA,
      proof: { branch: 'orch/tsk_wta', files_changed: [] },
    });
    const taskB = makeTask({
      id: 'tsk_wtb',
      status: 'in_progress',
      workspace: wtB,
      proof: { branch: 'orch/tsk_wtb', files_changed: [] },
    });
    const workspaceManager = {
      prepare: async () => ({ path: root }),
      mergeBack: async () => ({ success: true as const }),
      cleanup: async () => {},
      validate: () => {},
      getChangedFiles: async () => [],
      getChangedFileDiffs: async () => [],
    };
    const intelligence = mockIntelligence({
      detectChanges: async (input) => {
        seen.push(input.worktree);
        return emptySemantic({ worktree: input.worktree });
      },
    });
    const service = new CodeAdmissionService(
      new AdmissionStore(new Paths(root)),
      createMockTaskStore([taskA, taskB]),
      new EventBus(),
      enabledWorkflow,
      root,
      intelligence,
      workspaceManager,
    );
    await service.ensureFastPathContract(taskA);
    await service.ensureFastPathContract(taskB);
    expect((await service.auditTask(taskA)).passed).toBe(true);
    expect((await service.auditTask(taskB)).passed).toBe(true);
    expect(seen).toEqual([wtA, wtB]);

    const wrong = new CodeAdmissionService(
      new AdmissionStore(new Paths(root)),
      createMockTaskStore([taskA]),
      new EventBus(),
      enabledWorkflow,
      root,
      mockIntelligence({
        detectChanges: async () => emptySemantic({ worktree: wtB }),
      }),
      workspaceManager,
    );
    await wrong.ensureFastPathContract(taskA);
    const result = await wrong.auditTask(taskA);
    expect(result.passed).toBe(false);
    expect(result.violations.some((item) => item.kind === 'wrong_worktree')).toBe(true);
  });

  it('isolates real linked worktrees so task A audit cannot see task B files', async () => {
    const repo = path.join(root, 'repo');
    const wtA = path.join(root, 'wt-a');
    const wtB = path.join(root, 'wt-b');
    await mkdir(repo, { recursive: true });
    await execFileAsync('git', ['init', '-b', 'main'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.email', 'orch@test'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'orch'], { cwd: repo });
    await writeFile(path.join(repo, 'README.md'), 'base\n');
    await execFileAsync('git', ['add', 'README.md'], { cwd: repo });
    await execFileAsync('git', ['commit', '-m', 'base'], { cwd: repo });
    await execFileAsync('git', ['worktree', 'add', '-b', 'orch/a', wtA], { cwd: repo });
    await execFileAsync('git', ['worktree', 'add', '-b', 'orch/b', wtB], { cwd: repo });
    await writeFile(path.join(wtA, 'a-only.ts'), 'export const a = 1;\n');
    await execFileAsync('git', ['add', 'a-only.ts'], { cwd: wtA });
    await execFileAsync('git', ['commit', '-m', 'a'], { cwd: wtA });
    await writeFile(path.join(wtB, 'b-only.ts'), 'export const b = 1;\n');
    await execFileAsync('git', ['add', 'b-only.ts'], { cwd: wtB });
    await execFileAsync('git', ['commit', '-m', 'b'], { cwd: wtB });

    const seen: string[] = [];
    const workspaceManager = {
      prepare: async () => ({ path: repo }),
      mergeBack: async () => ({ success: true as const }),
      cleanup: async () => {},
      validate: () => {},
      getChangedFiles: async (branch: string) => {
        const { stdout: base } = await execFileAsync('git', ['merge-base', 'HEAD', branch], { cwd: repo });
        const { stdout } = await execFileAsync('git', ['diff', '--name-only', `${base.trim()}...${branch}`], { cwd: repo });
        return stdout.trim().split('\n').filter(Boolean);
      },
      getChangedFileDiffs: async (branch: string) => {
        const { stdout: base } = await execFileAsync('git', ['merge-base', 'HEAD', branch], { cwd: repo });
        const { stdout } = await execFileAsync('git', ['diff', '--name-status', `${base.trim()}...${branch}`], { cwd: repo });
        return stdout.trim().split('\n').filter(Boolean).map((line) => {
          const parts = line.split(/\s+/);
          const code = parts[0] ?? '';
          return {
            path: parts[parts.length - 1] ?? '',
            status: (code.startsWith('A') ? 'added' : 'modified') as 'added' | 'modified',
            addedLines: [] as string[],
          };
        });
      },
    };
    const taskA = makeTask({
      id: 'tsk_real_a',
      status: 'in_progress',
      workspace: wtA,
      proof: { branch: 'orch/a', files_changed: [] },
    });
    const taskB = makeTask({
      id: 'tsk_real_b',
      status: 'in_progress',
      workspace: wtB,
      proof: { branch: 'orch/b', files_changed: [] },
    });
    const service = new CodeAdmissionService(
      new AdmissionStore(new Paths(root)),
      createMockTaskStore([taskA, taskB]),
      new EventBus(),
      enabledWorkflow,
      repo,
      mockIntelligence({
        detectChanges: async (input) => {
          seen.push(input.worktree);
          return emptySemantic({
            worktree: input.worktree,
            modified_symbols: [{ name: 'x', path: 'README.md', change: 'modified' }],
          });
        },
      }),
      workspaceManager,
    );
    await service.ensureFastPathContract(taskA);
    await service.ensureFastPathContract(taskB);
    const resultA = await service.auditTask(taskA);
    const resultB = await service.auditTask(taskB);
    expect(resultA.added_files).toContain('a-only.ts');
    expect(resultA.added_files).not.toContain('b-only.ts');
    expect(resultB.added_files).toContain('b-only.ts');
    expect(resultB.added_files).not.toContain('a-only.ts');
    expect(seen).toEqual([wtA, wtB]);

    const crossed = new CodeAdmissionService(
      new AdmissionStore(new Paths(root)),
      createMockTaskStore([taskA]),
      new EventBus(),
      enabledWorkflow,
      repo,
      mockIntelligence({ detectChanges: async () => emptySemantic({ worktree: wtB }) }),
      workspaceManager,
    );
    await crossed.ensureFastPathContract(taskA);
    const wrong = await crossed.auditTask(taskA);
    expect(wrong.violations.some((item) => item.kind === 'wrong_worktree')).toBe(true);
  });

  it('does not treat an empty GitNexus change set as success when the worktree is unconfirmed', async () => {
    const wt = path.join(root, 'wt-unconfirmed');
    const task = makeTask({
      id: 'tsk_empty',
      status: 'in_progress',
      workspace: wt,
      proof: { branch: 'orch/tsk_empty', files_changed: [] },
    });
    const service = new CodeAdmissionService(
      new AdmissionStore(new Paths(root)),
      createMockTaskStore([task]),
      new EventBus(),
      enabledWorkflow,
      root,
      mockIntelligence({ detectChanges: async () => emptySemantic({ worktree: wt }) }),
      {
        prepare: async () => ({ path: wt }),
        mergeBack: async () => ({ success: true as const }),
        cleanup: async () => {},
        validate: () => {},
        getChangedFiles: async () => ['src/touched.ts'],
        getChangedFileDiffs: async () => [{ path: 'src/touched.ts', status: 'modified' as const, addedLines: ['x'] }],
      },
    );
    await service.ensureFastPathContract(task);
    const result = await service.auditTask(task);
    expect(result.passed).toBe(false);
    expect(result.incomplete).toBe(true);
    expect(result.violations.some((item) => item.kind === 'wrong_worktree')).toBe(true);
  });

  it('fails MEDIUM impact when dependents have no tests', async () => {
    const task = makeTask({
      id: 'tsk_med',
      status: 'in_progress',
      proof: { branch: 'orch/tsk_med', files_changed: ['src/foo.ts'] },
    });
    const service = new CodeAdmissionService(
      new AdmissionStore(new Paths(root)),
      createMockTaskStore([task]),
      new EventBus(),
      enabledWorkflow,
      root,
      mockIntelligence({
        detectChanges: async () => emptySemantic({
          risk: 'medium',
          modified_symbols: [{ name: 'foo', path: 'src/foo.ts', change: 'modified' }],
        }),
      }),
      {
        prepare: async () => ({ path: root }),
        mergeBack: async () => ({ success: true as const }),
        cleanup: async () => {},
        validate: () => {},
        getChangedFiles: async () => ['src/foo.ts'],
        getChangedFileDiffs: async () => [{ path: 'src/foo.ts', status: 'modified' as const, addedLines: ['x'] }],
      },
    );
    await service.ensureFastPathContract(task);
    const result = await service.auditTask(task);
    expect(result.passed).toBe(false);
    expect(result.violations.some((item) => item.message.includes('tests for dependents'))).toBe(true);
  });

  it('passes MEDIUM impact when the diff includes dependent tests', async () => {
    const task = makeTask({
      id: 'tsk_medok',
      status: 'in_progress',
      proof: { branch: 'orch/tsk_medok', files_changed: ['src/foo.ts', 'test/foo.test.ts'] },
    });
    const service = new CodeAdmissionService(
      new AdmissionStore(new Paths(root)),
      createMockTaskStore([task]),
      new EventBus(),
      enabledWorkflow,
      root,
      mockIntelligence({
        detectChanges: async () => emptySemantic({
          risk: 'medium',
          modified_symbols: [{ name: 'foo', path: 'src/foo.ts', change: 'modified' }],
        }),
      }),
      {
        prepare: async () => ({ path: root }),
        mergeBack: async () => ({ success: true as const }),
        cleanup: async () => {},
        validate: () => {},
        getChangedFiles: async () => ['src/foo.ts', 'test/foo.test.ts'],
        getChangedFileDiffs: async () => [
          { path: 'src/foo.ts', status: 'modified' as const, addedLines: ['x'] },
          { path: 'test/foo.test.ts', status: 'modified' as const, addedLines: ['it()'] },
        ],
      },
    );
    await service.ensureFastPathContract(task);
    const result = await service.auditTask(task);
    expect(result.passed).toBe(true);
  });

  it('fails CRITICAL impact without independent review even when high_risk_edit is approved', async () => {
    const task = makeTask({
      id: 'tsk_crit',
      status: 'in_progress',
      proof: { branch: 'orch/tsk_crit', files_changed: ['src/foo.ts'] },
    });
    const store = new AdmissionStore(new Paths(root));
    const service = new CodeAdmissionService(
      store,
      createMockTaskStore([task]),
      new EventBus(),
      enabledWorkflow,
      root,
      mockIntelligence({
        detectChanges: async () => emptySemantic({
          risk: 'critical',
          modified_symbols: [{ name: 'foo', path: 'src/foo.ts', change: 'modified' }],
        }),
      }),
      {
        prepare: async () => ({ path: root }),
        mergeBack: async () => ({ success: true as const }),
        cleanup: async () => {},
        validate: () => {},
        getChangedFiles: async () => ['src/foo.ts'],
        getChangedFileDiffs: async () => [{ path: 'src/foo.ts', status: 'modified' as const, addedLines: ['x'] }],
      },
    );
    await service.ensureFastPathContract(task);
    await store.saveRequest({
      id: 'adm_crit',
      task_id: task.id,
      type: 'high_risk_edit',
      requested_at: '2025-01-01T00:00:00Z',
      proposed: { name: 'foo', path: 'src/foo.ts' },
      status: 'approved',
    });
    const result = await service.auditTask(task);
    expect(result.passed).toBe(false);
    expect(result.violations.some((item) => item.message.includes('independent review'))).toBe(true);
  });

  it('passes CRITICAL impact with approved high_risk_edit and independent review', async () => {
    const task = makeTask({
      id: 'tsk_critok',
      status: 'in_progress',
      proof: { branch: 'orch/tsk_critok', files_changed: ['src/foo.ts'] },
      reviews: [{
        reviewer_type: 'cursor',
        commit_sha: 'abc1234',
        verdict: 'approve',
        summary: 'ok',
        timestamp: '2025-01-01T00:00:00Z',
      }],
    });
    const store = new AdmissionStore(new Paths(root));
    const service = new CodeAdmissionService(
      store,
      createMockTaskStore([task]),
      new EventBus(),
      enabledWorkflow,
      root,
      mockIntelligence({
        detectChanges: async () => emptySemantic({
          risk: 'critical',
          modified_symbols: [{ name: 'foo', path: 'src/foo.ts', change: 'modified' }],
        }),
      }),
      {
        prepare: async () => ({ path: root }),
        mergeBack: async () => ({ success: true as const }),
        cleanup: async () => {},
        validate: () => {},
        getChangedFiles: async () => ['src/foo.ts'],
        getChangedFileDiffs: async () => [{ path: 'src/foo.ts', status: 'modified' as const, addedLines: ['x'] }],
      },
    );
    await service.ensureFastPathContract(task);
    await store.saveRequest({
      id: 'adm_critok',
      task_id: task.id,
      type: 'high_risk_edit',
      requested_at: '2025-01-01T00:00:00Z',
      proposed: { name: 'foo', path: 'src/foo.ts' },
      status: 'approved',
    });
    const result = await service.auditTask(task);
    expect(result.passed).toBe(true);
  });

  it('includes branch and head_sha in the worker code-context prompt', async () => {
    const { service, taskA } = setup();
    const contract = await service.ensureFastPathContract(taskA);
    const block = service.renderPromptBlock(contract!, path.join(root, 'wt-a'), {
      branch: 'orch/tsk_aaa',
      head_sha: 'deadbeef',
    });
    expect(block).toContain('worktree_path:');
    expect(block).toContain('branch: orch/tsk_aaa');
    expect(block).toContain('head_sha: deadbeef');
    expect(block).toContain('orch admission request new-file|new-symbol|dependency');
  });

  it('binds the task worktree into the prompt after preflight without dispatch passing it', async () => {
    const wt = path.join(root, 'wt-preflight');
    const task = makeTask({
      id: 'tsk_pf',
      status: 'in_progress',
      workspace: wt,
      proof: { branch: 'orch/tsk_pf', files_changed: [], head_sha: 'cafebabe' },
    });
    const service = new CodeAdmissionService(
      new AdmissionStore(new Paths(root)),
      createMockTaskStore([task]),
      new EventBus(),
      enabledWorkflow,
      root,
    );
    await service.preflight(task);
    const contract = await service.ensureFastPathContract(task);
    const block = service.renderPromptBlock(contract!);
    expect(block).toContain(`worktree_path: ${wt}`);
    expect(block).toContain('gitnexus.worktree:');
    expect(block).toContain('branch: orch/tsk_pf');
    expect(block).toContain('head_sha: cafebabe');
  });

  it('rejects a superseded contract', async () => {
    const { service, store, taskA } = setup();
    const contract = await service.ensureFastPathContract(taskA);
    await store.saveContract({ ...contract!, status: 'superseded' });
    const result = await service.auditTask(taskA);
    expect(result.passed).toBe(false);
    expect(result.violations.some((item) => item.message.includes('Superseded'))).toBe(true);
  });

  it('does not treat a renamed file as an unapproved create', async () => {
    const task = makeTask({
      id: 'tsk_ren',
      status: 'in_progress',
      proof: { branch: 'orch/tsk_ren', files_changed: ['src/renamed.ts'] },
    });
    const service = new CodeAdmissionService(
      new AdmissionStore(new Paths(root)),
      createMockTaskStore([task]),
      new EventBus(),
      enabledWorkflow,
      root,
      mockIntelligence(),
      {
        prepare: async () => ({ path: root }),
        mergeBack: async () => ({ success: true as const }),
        cleanup: async () => {},
        validate: () => {},
        getChangedFiles: async () => ['src/renamed.ts'],
        getChangedFileDiffs: async () => [{ path: 'src/renamed.ts', status: 'renamed' as const, addedLines: [] }],
      },
    );
    await service.ensureFastPathContract(task);
    const result = await service.auditTask(task);
    expect(result.passed).toBe(true);
    expect(result.added_files).toEqual([]);
  });

  it('fails an unapproved package.json dependency', async () => {
    const task = makeTask({
      id: 'tsk_dep',
      status: 'in_progress',
      proof: { branch: 'orch/tsk_dep', files_changed: ['package.json'] },
    });
    const service = new CodeAdmissionService(
      new AdmissionStore(new Paths(root)),
      createMockTaskStore([task]),
      new EventBus(),
      enabledWorkflow,
      root,
      mockIntelligence(),
      {
        prepare: async () => ({ path: root }),
        mergeBack: async () => ({ success: true as const }),
        cleanup: async () => {},
        validate: () => {},
        getChangedFiles: async () => ['package.json'],
        getChangedFileDiffs: async () => [{
          path: 'package.json',
          status: 'modified' as const,
          addedLines: ['    "left-pad": "1.3.0"'],
        }],
      },
    );
    await service.ensureFastPathContract(task);
    const result = await service.auditTask(task);
    expect(result.passed).toBe(false);
    expect(result.violations.some((item) => item.kind === 'unapproved_dependency')).toBe(true);
  });

  it('fails merge-back audit when conventions forbid a new util file', async () => {
    const task = makeTask({
      id: 'tsk_conv',
      status: 'in_progress',
      proof: { branch: 'orch/tsk_conv', files_changed: ['src/utils/dates.ts'] },
    });
    const workflow = {
      ...enabledWorkflow,
      conventions: { enabled: true },
    } as WorkflowConfig;
    const service = new CodeAdmissionService(
      new AdmissionStore(new Paths(root)),
      createMockTaskStore([task]),
      new EventBus(),
      workflow,
      root,
      mockIntelligence(),
      {
        prepare: async () => ({ path: root }),
        mergeBack: async () => ({ success: true as const }),
        cleanup: async () => {},
        validate: () => {},
        getChangedFiles: async () => ['src/utils/dates.ts'],
        getChangedFileDiffs: async () => [{
          path: 'src/utils/dates.ts',
          status: 'added' as const,
          addedLines: ['export const now = () => Date.now();'],
        }],
      },
    );
    await service.ensureFastPathContract(task);
    const result = await service.auditTask(task);
    expect(result.passed).toBe(false);
    expect(result.violations.some((item) => item.message.startsWith('conventions:'))).toBe(true);
  });

  it('does not apply conventions when the workflow key is missing', async () => {
    const task = makeTask({
      id: 'tsk_noconv',
      status: 'in_progress',
      proof: { branch: 'orch/tsk_noconv', files_changed: ['src/utils/dates.ts'] },
    });
    const service = new CodeAdmissionService(
      new AdmissionStore(new Paths(root)),
      createMockTaskStore([task]),
      new EventBus(),
      enabledWorkflow,
      root,
      mockIntelligence(),
      {
        prepare: async () => ({ path: root }),
        mergeBack: async () => ({ success: true as const }),
        cleanup: async () => {},
        validate: () => {},
        getChangedFiles: async () => ['src/utils/dates.ts'],
        getChangedFileDiffs: async () => [{
          path: 'src/utils/dates.ts',
          status: 'added' as const,
          addedLines: ['export const now = () => Date.now();'],
        }],
      },
    );
    await service.ensureFastPathContract(task);
    const result = await service.auditTask(task);
    expect(result.violations.some((item) => item.message.startsWith('conventions:'))).toBe(false);
  });

  it('fails merge-back audit when a task adds more than max_new_files_per_task', async () => {
    const files = Array.from({ length: 9 }, (_, index) => `src/mod${index}.ts`);
    const task = makeTask({
      id: 'tsk_max',
      status: 'in_progress',
      proof: { branch: 'orch/tsk_max', files_changed: files },
    });
    const workflow = {
      ...enabledWorkflow,
      conventions: { enabled: true },
    } as WorkflowConfig;
    const service = new CodeAdmissionService(
      new AdmissionStore(new Paths(root)),
      createMockTaskStore([task]),
      new EventBus(),
      workflow,
      root,
      mockIntelligence(),
      {
        prepare: async () => ({ path: root }),
        mergeBack: async () => ({ success: true as const }),
        cleanup: async () => {},
        validate: () => {},
        getChangedFiles: async () => files,
        getChangedFileDiffs: async () => files.map((filePath) => ({
          path: filePath,
          status: 'added' as const,
          addedLines: ['/** Header. */', 'export const n = 1;'],
        })),
      },
    );
    await service.ensureFastPathContract(task);
    const result = await service.auditTask(task);
    expect(result.violations.some((item) => item.message.includes('max_new_files_per_task'))).toBe(true);
  });

  it('fails merge-back audit when a task adds function JSDoc', async () => {
    const task = makeTask({
      id: 'tsk_jsdoc',
      status: 'in_progress',
      proof: { branch: 'orch/tsk_jsdoc', files_changed: ['src/existing.ts'] },
    });
    const workflow = {
      ...enabledWorkflow,
      conventions: { enabled: true },
    } as WorkflowConfig;
    const service = new CodeAdmissionService(
      new AdmissionStore(new Paths(root)),
      createMockTaskStore([task]),
      new EventBus(),
      workflow,
      root,
      mockIntelligence(),
      {
        prepare: async () => ({ path: root }),
        mergeBack: async () => ({ success: true as const }),
        cleanup: async () => {},
        validate: () => {},
        getChangedFiles: async () => ['src/existing.ts'],
        getChangedFileDiffs: async () => [{
          path: 'src/existing.ts',
          status: 'modified' as const,
          addedLines: ['/**', ' * @param attempts retry count', ' */', 'export function retry() {}'],
        }],
      },
    );
    await service.ensureFastPathContract(task);
    const result = await service.auditTask(task);
    expect(result.violations.some((item) => item.message.includes('function JSDoc'))).toBe(true);
  });

  it('does not treat // inside strings, templates, or regexes as comments', async () => {
    const task = makeTask({
      id: 'tsk_str',
      status: 'in_progress',
      proof: { branch: 'orch/tsk_str', files_changed: ['src/urls.ts'] },
    });
    const workflow = {
      ...enabledWorkflow,
      conventions: { enabled: true },
    } as WorkflowConfig;
    const service = new CodeAdmissionService(
      new AdmissionStore(new Paths(root)),
      createMockTaskStore([task]),
      new EventBus(),
      workflow,
      root,
      mockIntelligence(),
      {
        prepare: async () => ({ path: root }),
        mergeBack: async () => ({ success: true as const }),
        cleanup: async () => {},
        validate: () => {},
        getChangedFiles: async () => ['src/urls.ts'],
        getChangedFileDiffs: async () => [{
          path: 'src/urls.ts',
          status: 'added' as const,
          addedLines: [
            '/** File header. */',
            'export const href = "// not a comment";',
            'export const tpl = `https://example.com/${id}`;',
            'export const re = /https://example.com/i;',
            'export const n = 1;',
          ],
        }],
      },
    );
    await service.ensureFastPathContract(task);
    const result = await service.auditTask(task);
    expect(result.violations.some((item) => item.message.includes('inline comment'))).toBe(false);
    expect(result.violations.some((item) => item.message.includes('header'))).toBe(false);
  });

  it('rejects a mid-file comment after a valid header', async () => {
    const task = makeTask({
      id: 'tsk_mid',
      status: 'in_progress',
      proof: { branch: 'orch/tsk_mid', files_changed: ['src/mid.ts'] },
    });
    const workflow = {
      ...enabledWorkflow,
      conventions: { enabled: true },
    } as WorkflowConfig;
    const service = new CodeAdmissionService(
      new AdmissionStore(new Paths(root)),
      createMockTaskStore([task]),
      new EventBus(),
      workflow,
      root,
      mockIntelligence(),
      {
        prepare: async () => ({ path: root }),
        mergeBack: async () => ({ success: true as const }),
        cleanup: async () => {},
        validate: () => {},
        getChangedFiles: async () => ['src/mid.ts'],
        getChangedFileDiffs: async () => [{
          path: 'src/mid.ts',
          status: 'added' as const,
          addedLines: [
            '/** File header. */',
            'export const n = 1;',
            '// leftover note',
          ],
        }],
      },
    );
    await service.ensureFastPathContract(task);
    const result = await service.auditTask(task);
    expect(result.violations.some((item) => item.message.includes('inline comment after the file header'))).toBe(true);
  });

  it('accepts shebang plus use strict before a 3-line header and rejects a 5-line header', async () => {
    const workflow = {
      ...enabledWorkflow,
      conventions: { enabled: true },
    } as WorkflowConfig;
    const okTask = makeTask({
      id: 'tsk_hdr_ok',
      status: 'in_progress',
      proof: { branch: 'orch/tsk_hdr_ok', files_changed: ['src/cli.ts'] },
    });
    const okService = new CodeAdmissionService(
      new AdmissionStore(new Paths(root)),
      createMockTaskStore([okTask]),
      new EventBus(),
      workflow,
      root,
      mockIntelligence(),
      {
        prepare: async () => ({ path: root }),
        mergeBack: async () => ({ success: true as const }),
        cleanup: async () => {},
        validate: () => {},
        getChangedFiles: async () => ['src/cli.ts'],
        getChangedFileDiffs: async () => [{
          path: 'src/cli.ts',
          status: 'added' as const,
          addedLines: [
            '#!/usr/bin/env node',
            "'use strict';",
            '/**',
            ' * CLI entry.',
            ' * Owns dispatch.',
            ' */',
            'export const main = () => 0;',
          ],
        }],
      },
    );
    await okService.ensureFastPathContract(okTask);
    const ok = await okService.auditTask(okTask);
    expect(ok.violations.some((item) => item.message.includes('header') || item.message.includes('inline comment'))).toBe(false);

    const longTask = makeTask({
      id: 'tsk_hdr_long',
      status: 'in_progress',
      proof: { branch: 'orch/tsk_hdr_long', files_changed: ['src/long.ts'] },
    });
    const longService = new CodeAdmissionService(
      new AdmissionStore(new Paths(root)),
      createMockTaskStore([longTask]),
      new EventBus(),
      workflow,
      root,
      mockIntelligence(),
      {
        prepare: async () => ({ path: root }),
        mergeBack: async () => ({ success: true as const }),
        cleanup: async () => {},
        validate: () => {},
        getChangedFiles: async () => ['src/long.ts'],
        getChangedFileDiffs: async () => [{
          path: 'src/long.ts',
          status: 'added' as const,
          addedLines: [
            '/**',
            ' * one',
            ' * two',
            ' * three',
            ' * four',
            ' * five',
            ' */',
            'export const n = 1;',
          ],
        }],
      },
    );
    await longService.ensureFastPathContract(longTask);
    const long = await longService.auditTask(longTask);
    expect(long.violations.some((item) => item.message.includes('header must be'))).toBe(true);
  });

  it('emits workspace conventions events from the light CLI audit wrap', async () => {
    await mkdir(path.join(root, 'src', 'utils'), { recursive: true });
    await mkdir(path.join(root, '.orch'), { recursive: true });
    await mkdir(path.join(root, '.orchestry'), { recursive: true });
    await writeFile(path.join(root, 'src', 'existing.ts'), 'export const n = 1;\n');
    await writeFile(
      path.join(root, '.orch', 'workflow.yml'),
      [
        'version: 1',
        'code_admission:',
        '  enabled: true',
        '  audit:',
        '    require_gitnexus_detect_changes: false',
        'code_intelligence:',
        '  setup:',
        '    require_current_index: false',
        'conventions:',
        '  enabled: true',
        '',
      ].join('\n'),
    );
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'test'], { cwd: root });
    await execFileAsync('git', ['add', 'src/existing.ts'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: root });
    await execFileAsync('git', ['checkout', '-b', 'orch/conv'], { cwd: root });
    await writeFile(path.join(root, 'src', 'utils', 'dates.ts'), 'export const now = () => Date.now();\n');
    const { buildLightContainer } = await import('../../../src/container.js');
    const container = await buildLightContainer({
      projectRoot: root,
      json: false,
      quiet: true,
      noColor: true,
      ascii: true,
    });
    const seen: string[] = [];
    container.eventBus.onAny((event) => {
      seen.push(event.type);
    });
    const task = makeTask({
      id: 'tsk_conv_evt',
      status: 'in_progress',
      workspace: root,
      proof: { branch: 'orch/conv', files_changed: ['src/utils/dates.ts'] },
    });
    await container.taskStore.save(task);
    await container.codeAdmissionService.ensureFastPathContract(task);
    const result = await container.codeAdmissionService.auditTask(task);
    expect(result.violations.some((item) => item.message.startsWith('conventions:'))).toBe(true);
    expect(seen).toContain('workspace:conventions_failed');
    expect(seen).not.toContain('workspace:conventions_passed');
    const stored = await container.taskStore.get(task.id);
    expect(stored?.feedback).toMatch(/conventions:/);
    await container.codeIntelligence?.close?.();
  });

  it('allows listed eslint-disable comments on modified files', async () => {
    const task = makeTask({
      id: 'tsk_eslint',
      status: 'in_progress',
      proof: { branch: 'orch/tsk_eslint', files_changed: ['src/existing.ts'] },
    });
    const workflow = {
      ...enabledWorkflow,
      conventions: { enabled: true },
    } as WorkflowConfig;
    const service = new CodeAdmissionService(
      new AdmissionStore(new Paths(root)),
      createMockTaskStore([task]),
      new EventBus(),
      workflow,
      root,
      mockIntelligence(),
      {
        prepare: async () => ({ path: root }),
        mergeBack: async () => ({ success: true as const }),
        cleanup: async () => {},
        validate: () => {},
        getChangedFiles: async () => ['src/existing.ts'],
        getChangedFileDiffs: async () => [{
          path: 'src/existing.ts',
          status: 'modified' as const,
          addedLines: ['  // eslint-disable-next-line no-await-in-loop', '  await step();'],
        }],
      },
    );
    await service.ensureFastPathContract(task);
    const result = await service.auditTask(task);
    expect(result.violations.some((item) => item.message.includes('inline comment'))).toBe(false);
  });

  it('lints added comment lines in shared-workspace fallback diffs', async () => {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'existing.ts'), 'export const n = 1;\n');
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'test'], { cwd: root });
    await execFileAsync('git', ['add', 'src/existing.ts'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: root });
    await writeFile(path.join(root, 'src', 'existing.ts'), 'export const n = 1;\n// added later\n');

    const task = makeTask({
      id: 'tsk_shared',
      status: 'in_progress',
      scope: ['src/**'],
      proof: { files_changed: ['src/existing.ts'] },
    });
    const workflow = {
      ...enabledWorkflow,
      conventions: { enabled: true },
    } as WorkflowConfig;
    const service = new CodeAdmissionService(
      new AdmissionStore(new Paths(root)),
      createMockTaskStore([task]),
      new EventBus(),
      workflow,
      root,
      mockIntelligence(),
    );
    await service.ensureFastPathContract(task);
    const result = await service.auditTask(task);
    expect(result.violations.some((item) => item.message.includes('added an inline comment'))).toBe(true);
  });

  it('treats untracked files as added in shared-workspace fallback diffs', async () => {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'existing.ts'), 'export const n = 1;\n');
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'test'], { cwd: root });
    await execFileAsync('git', ['add', 'src/existing.ts'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: root });
    await writeFile(path.join(root, 'src', 'untracked-new.ts'), 'export const extra = 2;\n');

    const task = makeTask({
      id: 'tsk_untracked',
      status: 'in_progress',
      scope: ['src/**'],
      proof: { files_changed: ['src/untracked-new.ts'] },
    });
    const service = new CodeAdmissionService(
      new AdmissionStore(new Paths(root)),
      createMockTaskStore([task]),
      new EventBus(),
      enabledWorkflow,
      root,
      mockIntelligence(),
    );
    await service.ensureFastPathContract(task);
    const result = await service.auditTask(task);
    expect(result.added_files.some((file) => file.replace(/\\/g, '/').endsWith('src/untracked-new.ts'))).toBe(true);
    expect(result.violations.some((item) => item.message.includes('Unapproved new file') && item.message.includes('untracked-new.ts'))).toBe(true);
  });

  it('light CLI audit treats untracked files as added when the branch diff is empty', async () => {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, '.orch'), { recursive: true });
    await mkdir(path.join(root, '.orchestry'), { recursive: true });
    await writeFile(path.join(root, 'src', 'existing.ts'), 'export const n = 1;\n');
    await writeFile(
      path.join(root, '.orch', 'workflow.yml'),
      [
        'version: 1',
        'code_admission:',
        '  enabled: true',
        '  audit:',
        '    require_gitnexus_detect_changes: false',
        'code_intelligence:',
        '  setup:',
        '    require_current_index: false',
        '',
      ].join('\n'),
    );
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'test'], { cwd: root });
    await execFileAsync('git', ['add', 'src/existing.ts'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: root });
    await execFileAsync('git', ['checkout', '-b', 'orch/hidden'], { cwd: root });
    await writeFile(path.join(root, 'src', 'hidden-create.ts'), 'export const hidden = 1;\n');
    const { buildLightContainer } = await import('../../../src/container.js');
    const container = await buildLightContainer({
      projectRoot: root,
      json: false,
      quiet: true,
      noColor: true,
      ascii: true,
    });
    const task = makeTask({
      id: 'tsk_hidden',
      status: 'in_progress',
      workspace: root,
      proof: { branch: 'orch/hidden', files_changed: ['src/hidden-create.ts'] },
    });
    await container.taskStore.save(task);
    await container.codeAdmissionService.ensureFastPathContract(task);
    const result = await container.codeAdmissionService.auditTask(task);
    expect(result.added_files.some((file) => file.replace(/\\/g, '/').endsWith('src/hidden-create.ts'))).toBe(true);
    expect(result.violations.some((item) => item.message.includes('Unapproved new file') && item.message.includes('hidden-create.ts'))).toBe(true);
  });

  it('light CLI audit treats a staged-only add as an unapproved create', async () => {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, '.orch'), { recursive: true });
    await mkdir(path.join(root, '.orchestry'), { recursive: true });
    await writeFile(path.join(root, 'src', 'existing.ts'), 'export const n = 1;\n');
    await writeFile(
      path.join(root, '.orch', 'workflow.yml'),
      [
        'version: 1',
        'code_admission:',
        '  enabled: true',
        '  audit:',
        '    require_gitnexus_detect_changes: false',
        'code_intelligence:',
        '  setup:',
        '    require_current_index: false',
        '',
      ].join('\n'),
    );
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'test'], { cwd: root });
    await execFileAsync('git', ['add', 'src/existing.ts'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: root });
    await execFileAsync('git', ['checkout', '-b', 'orch/staged'], { cwd: root });
    await writeFile(path.join(root, 'src', 'staged-create.ts'), 'export const staged = 1;\n');
    await execFileAsync('git', ['add', 'src/staged-create.ts'], { cwd: root });
    const { buildLightContainer } = await import('../../../src/container.js');
    const container = await buildLightContainer({
      projectRoot: root,
      json: false,
      quiet: true,
      noColor: true,
      ascii: true,
    });
    const task = makeTask({
      id: 'tsk_staged',
      status: 'in_progress',
      workspace: root,
      proof: { branch: 'orch/staged', files_changed: ['src/staged-create.ts'] },
    });
    await container.taskStore.save(task);
    await container.codeAdmissionService.ensureFastPathContract(task);
    const result = await container.codeAdmissionService.auditTask(task);
    expect(result.added_files.some((file) => file.replace(/\\/g, '/').endsWith('src/staged-create.ts'))).toBe(true);
    expect(result.violations.some((item) => item.message.includes('Unapproved new file') && item.message.includes('staged-create.ts'))).toBe(true);
    await container.codeIntelligence?.close?.();
  });

  it('light CLI audit sees JSDoc added in an unstaged existing-file edit', async () => {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, '.orch'), { recursive: true });
    await mkdir(path.join(root, '.orchestry'), { recursive: true });
    await writeFile(path.join(root, 'src', 'existing.ts'), 'export const n = 1;\n');
    await writeFile(
      path.join(root, '.orch', 'workflow.yml'),
      [
        'version: 1',
        'code_admission:',
        '  enabled: true',
        '  audit:',
        '    require_gitnexus_detect_changes: false',
        'code_intelligence:',
        '  setup:',
        '    require_current_index: false',
        'conventions:',
        '  enabled: true',
        '',
      ].join('\n'),
    );
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'test'], { cwd: root });
    await execFileAsync('git', ['add', 'src/existing.ts'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: root });
    await execFileAsync('git', ['checkout', '-b', 'orch/unstaged'], { cwd: root });
    await writeFile(
      path.join(root, 'src', 'existing.ts'),
      '/** @param value count */\nexport const n = 1;\nexport function bump(value: number): number { return value + 1; }\n',
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
      id: 'tsk_unstaged',
      status: 'in_progress',
      workspace: root,
      proof: { branch: 'orch/unstaged', files_changed: ['src/existing.ts'] },
    });
    await container.taskStore.save(task);
    await container.codeAdmissionService.ensureFastPathContract(task);
    const result = await container.codeAdmissionService.auditTask(task);
    expect(result.violations.some((item) => item.message.includes('added function JSDoc') && item.message.includes('existing.ts'))).toBe(true);
    await container.codeIntelligence?.close?.();
  });

  it('light CLI audit does not treat an unstaged delete as a create', async () => {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, '.orch'), { recursive: true });
    await mkdir(path.join(root, '.orchestry'), { recursive: true });
    await writeFile(path.join(root, 'src', 'existing.ts'), 'export const n = 1;\n');
    await writeFile(
      path.join(root, '.orch', 'workflow.yml'),
      [
        'version: 1',
        'code_admission:',
        '  enabled: true',
        '  audit:',
        '    require_gitnexus_detect_changes: false',
        'code_intelligence:',
        '  setup:',
        '    require_current_index: false',
        '',
      ].join('\n'),
    );
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'test'], { cwd: root });
    await execFileAsync('git', ['add', 'src/existing.ts', '.orch/workflow.yml'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: root });
    await execFileAsync('git', ['checkout', '-b', 'orch/deleted'], { cwd: root });
    await rm(path.join(root, 'src', 'existing.ts'));
    const { buildLightContainer } = await import('../../../src/container.js');
    const container = await buildLightContainer({
      projectRoot: root,
      json: false,
      quiet: true,
      noColor: true,
      ascii: true,
    });
    const task = makeTask({
      id: 'tsk_deleted',
      status: 'in_progress',
      workspace: root,
      proof: { branch: 'orch/deleted', files_changed: ['src/existing.ts'] },
    });
    await container.taskStore.save(task);
    await container.codeAdmissionService.ensureFastPathContract(task);
    const result = await container.codeAdmissionService.auditTask(task);
    expect(result.added_files.some((file) => file.replace(/\\/g, '/').endsWith('src/existing.ts'))).toBe(false);
    expect(result.violations.some((item) => item.message.includes('Unapproved new file') && item.message.includes('existing.ts'))).toBe(false);
    await container.codeIntelligence?.close?.();
  });

  it('light CLI audit does not treat a staged rename as a create', async () => {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, '.orch'), { recursive: true });
    await mkdir(path.join(root, '.orchestry'), { recursive: true });
    await writeFile(path.join(root, 'src', 'existing.ts'), 'export const n = 1;\n');
    await writeFile(
      path.join(root, '.orch', 'workflow.yml'),
      [
        'version: 1',
        'code_admission:',
        '  enabled: true',
        '  audit:',
        '    require_gitnexus_detect_changes: false',
        'code_intelligence:',
        '  setup:',
        '    require_current_index: false',
        '',
      ].join('\n'),
    );
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'test'], { cwd: root });
    await execFileAsync('git', ['add', 'src/existing.ts', '.orch/workflow.yml'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: root });
    await execFileAsync('git', ['checkout', '-b', 'orch/renamed'], { cwd: root });
    await execFileAsync('git', ['mv', 'src/existing.ts', 'src/renamed.ts'], { cwd: root });
    const { buildLightContainer } = await import('../../../src/container.js');
    const container = await buildLightContainer({
      projectRoot: root,
      json: false,
      quiet: true,
      noColor: true,
      ascii: true,
    });
    const task = makeTask({
      id: 'tsk_renamed_wt',
      status: 'in_progress',
      workspace: root,
      proof: { branch: 'orch/renamed', files_changed: ['src/renamed.ts'] },
    });
    await container.taskStore.save(task);
    await container.codeAdmissionService.ensureFastPathContract(task);
    const result = await container.codeAdmissionService.auditTask(task);
    expect(result.added_files.some((file) => file.replace(/\\/g, '/').endsWith('src/renamed.ts'))).toBe(false);
    expect(result.violations.some((item) => item.message.includes('Unapproved new file') && item.message.includes('renamed.ts'))).toBe(false);
    await container.codeIntelligence?.close?.();
  });

  it('fails closed when the shared workspace is dirty beyond the task', async () => {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'existing.ts'), 'export const n = 1;\n');
    await execFileAsync('git', ['init'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'test'], { cwd: root });
    await execFileAsync('git', ['add', 'src/existing.ts'], { cwd: root });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: root });
    await writeFile(path.join(root, 'src', 'existing.ts'), 'export const n = 2;\n');
    await writeFile(path.join(root, 'src', 'leftover.ts'), 'export const leftover = 1;\n');

    const task = makeTask({
      id: 'tsk_dirty',
      status: 'in_progress',
      workspace_mode: 'shared',
      proof: { files_changed: ['src/existing.ts'] },
    });
    const workflow = {
      ...enabledWorkflow,
      conventions: { enabled: true },
    } as WorkflowConfig;
    const service = new CodeAdmissionService(
      new AdmissionStore(new Paths(root)),
      createMockTaskStore([task]),
      new EventBus(),
      workflow,
      root,
      mockIntelligence(),
    );
    await service.ensureFastPathContract(task);
    const result = await service.auditTask(task);
    expect(result.passed).toBe(false);
    expect(result.violations.some((item) => item.message.includes('shared workspace is dirty; cannot attribute convention violations'))).toBe(true);
  });

  it('records deleted symbols and affected processes', async () => {
    const task = makeTask({
      id: 'tsk_del',
      status: 'in_progress',
      proof: { branch: 'orch/tsk_del', files_changed: ['src/foo.ts'] },
    });
    const service = new CodeAdmissionService(
      new AdmissionStore(new Paths(root)),
      createMockTaskStore([task]),
      new EventBus(),
      enabledWorkflow,
      root,
      mockIntelligence({
        detectChanges: async () => emptySemantic({
          deleted_symbols: [{ name: 'oldHelper', path: 'src/foo.ts', change: 'deleted' }],
          processes: ['RetryFlow'],
        }),
      }),
      {
        prepare: async () => ({ path: root }),
        mergeBack: async () => ({ success: true as const }),
        cleanup: async () => {},
        validate: () => {},
        getChangedFiles: async () => ['src/foo.ts'],
        getChangedFileDiffs: async () => [{ path: 'src/foo.ts', status: 'modified' as const, addedLines: [] }],
      },
    );
    await service.ensureFastPathContract(task);
    const result = await service.auditTask(task);
    expect(result.passed).toBe(true);
    expect(result.deleted_symbols).toEqual(['oldHelper']);
    expect(result.processes).toEqual(['RetryFlow']);
  });

  it('light CLI searchExisting includes global admission reservations', async () => {
    await mkdir(path.join(root, '.orchestry'), { recursive: true });
    const { buildLightContainer } = await import('../../../src/container.js');
    const container = await buildLightContainer({
      projectRoot: root,
      json: false,
      quiet: true,
      noColor: true,
      ascii: true,
    });
    await container.admissionStore.addReservation({
      kind: 'symbol',
      name: 'reservedUniqueHelper',
      path: 'src/reserved-unique-helper.ts',
      task_id: 'tsk_reserved',
      request_id: 'adm_reserved',
    });
    const hits = await container.codeIntelligence.searchExisting({
      query: 'reservedUniqueHelper',
      worktree: root,
    });
    expect(hits.some((hit) => (
      hit.path === 'src/reserved-unique-helper.ts'
      && hit.snippet === 'reserved by tsk_reserved'
    ))).toBe(true);
    await container.codeIntelligence?.close?.();
  });

  it('light CLI save drops a depends_on edge that would cycle', async () => {
    await mkdir(path.join(root, '.orchestry'), { recursive: true });
    const { buildLightContainer } = await import('../../../src/container.js');
    const container = await buildLightContainer({
      projectRoot: root,
      json: false,
      quiet: true,
      noColor: true,
      ascii: true,
    });
    const taskA = makeTask({ id: 'tsk_cycle_a', depends_on: ['tsk_cycle_b'] });
    const taskB = makeTask({ id: 'tsk_cycle_b', depends_on: [] });
    await container.taskStore.save(taskA);
    await container.taskStore.save(taskB);
    taskB.depends_on = ['tsk_cycle_a'];
    await container.taskStore.save(taskB);
    expect((await container.taskStore.get('tsk_cycle_b'))?.depends_on).not.toContain('tsk_cycle_a');
    expect((await container.taskStore.get('tsk_cycle_a'))?.depends_on).toContain('tsk_cycle_b');
    await container.codeIntelligence?.close?.();
  });

  it('light CLI redirect does not add depends_on when that would cycle', async () => {
    await mkdir(path.join(root, '.orch'), { recursive: true });
    await mkdir(path.join(root, '.orchestry'), { recursive: true });
    await writeFile(
      path.join(root, '.orch', 'workflow.yml'),
      ['version: 1', 'code_admission:', '  enabled: true', ''].join('\n'),
    );
    const { buildLightContainer } = await import('../../../src/container.js');
    const container = await buildLightContainer({
      projectRoot: root,
      json: false,
      quiet: true,
      noColor: true,
      ascii: true,
    });
    const taskA = makeTask({ id: 'tsk_owner', status: 'in_progress', depends_on: ['tsk_waiter'] });
    const taskB = makeTask({ id: 'tsk_waiter', status: 'in_progress', depends_on: [] });
    await container.taskStore.save(taskA);
    await container.taskStore.save(taskB);
    await container.admissionStore.addReservation({
      kind: 'file',
      path: 'src/shared-retry.ts',
      task_id: taskA.id,
    });
    const request = await container.codeAdmissionService.submitRequest({
      task_id: taskB.id,
      type: 'new_file',
      proposed: { path: 'src/shared-retry.ts' },
    });
    expect(request.status).toBe('redirected');
    expect((await container.taskStore.get(taskB.id))?.depends_on).not.toContain(taskA.id);
    await container.codeIntelligence?.close?.();
  });

  it('light CLI audit events include deleted symbols and processes', async () => {
    await mkdir(path.join(root, '.orch'), { recursive: true });
    await mkdir(path.join(root, '.orchestry'), { recursive: true });
    await writeFile(
      path.join(root, '.orch', 'workflow.yml'),
      [
        'version: 1',
        'code_intelligence:',
        '  setup:',
        '    require_current_index: false',
        'code_admission:',
        '  enabled: true',
        '  audit:',
        '    require_gitnexus_detect_changes: true',
        '    require_current_index: false',
        '',
      ].join('\n'),
    );
    const { buildLightContainer } = await import('../../../src/container.js');
    const container = await buildLightContainer({
      projectRoot: root,
      json: false,
      quiet: true,
      noColor: true,
      ascii: true,
    });
    container.codeIntelligence!.detectChanges = async () => ({
      added_symbols: [],
      modified_symbols: [],
      deleted_symbols: [{ name: 'oldHelper', path: 'src/foo.ts', change: 'deleted' }],
      processes: ['RetryFlow'],
      partial: false,
      truncated: false,
      degraded: false,
      worktree: root,
    });
    const seen: Array<{ type: string; deleted_symbols?: string[]; processes?: string[] }> = [];
    container.eventBus.onAny((event) => {
      seen.push(event);
    });
    const task = makeTask({
      id: 'tsk_evt_del',
      status: 'in_progress',
      workspace: root,
      proof: { branch: 'orch/evt', files_changed: ['src/foo.ts'] },
    });
    await container.taskStore.save(task);
    await container.codeAdmissionService.ensureFastPathContract(task);
    await container.codeAdmissionService.auditTask(task);
    const audit = seen.find((event) => event.type === 'code_admission:audit_completed');
    expect(audit?.deleted_symbols).toEqual(['oldHelper']);
    expect(audit?.processes).toEqual(['RetryFlow']);
    await container.codeIntelligence?.close?.();
  });
});
