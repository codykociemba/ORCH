import { describe, it, expect, vi } from 'vitest';
import { Orchestrator } from '../../../src/application/orchestrator.js';
import {
  buildDeps,
  makeTask,
  makeAgent,
  makeRun,
  createMockTaskStore,
  createMockAgentStore,
  createMockRunStore,
  createMockStateStore,
  createMockWorkspaceManager,
} from './helpers.js';

describe('admission audit before mergeBack', () => {
  it('blocks merge when the audit fails', async () => {
    const task = makeTask({
      id: 'tsk_1',
      status: 'in_progress',
      attempts: 1,
      proof: { branch: 'orch/tsk_1', files_changed: ['a.ts'] },
    });
    const agent = makeAgent({ id: 'agt_1', status: 'busy', current_task: 'tsk_1' });
    const run = makeRun({ id: 'run_1', task_id: 'tsk_1', agent_id: 'agt_1', status: 'streaming' });
    const taskStore = createMockTaskStore([task]);
    const agentStore = createMockAgentStore([agent]);
    const runStore = createMockRunStore();
    await runStore.save(run);
    const workspaceManager = createMockWorkspaceManager();
    const codeAdmissionService = {
      enabled: () => true,
      auditTask: vi.fn(async () => ({
        passed: false,
        incomplete: false,
        violations: [{ kind: 'unapproved_file' as const, message: 'Unapproved new file: src/x.ts' }],
        added_files: ['src/x.ts'],
        added_symbols: [],
      })),
      releaseTask: vi.fn(async () => {}),
      processPending: vi.fn(async () => {}),
    };

    const orch = new Orchestrator(buildDeps({
      taskStore,
      agentStore,
      runStore,
      stateStore: createMockStateStore({
        running: {
          tsk_1: {
            runId: 'run_1',
            taskId: 'tsk_1',
            agentId: 'agt_1',
            pid: 1,
            started_at: '2025-01-01T00:00:00Z',
          },
        },
      }),
      workspaceManager,
      codeAdmissionService: codeAdmissionService as never,
    }));
    await (orch as unknown as { loadState: () => Promise<void> }).loadState();
    await (orch as unknown as { _handleRunSuccess: (...args: unknown[]) => Promise<void> })
      ._handleRunSuccess('tsk_1', 'run_1', 'agt_1', undefined, 'done', ['a.ts']);

    expect(workspaceManager.mergeBack).not.toHaveBeenCalled();
    const updated = await taskStore.get('tsk_1');
    expect(updated?.status).toBe('review');
    expect(updated?.feedback).toContain('Unapproved new file');
  });
});
