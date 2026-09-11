import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
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
    await rm(root, { recursive: true, force: true });
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
});
