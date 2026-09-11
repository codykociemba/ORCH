/**
 * Dependency injection container.
 *
 * Plain TypeScript object — no framework, no decorators.
 * Two modes:
 *   - LightContainer: stores + services only (fast, for read-only commands)
 *   - Container: full (+ orchestrator, adapters, template engine)
 */

import type { OrchestratorConfig } from './domain/config.js';
import type { CliContext } from './cli/context.js';
import type { ITaskStore, IAgentStore, IRunStore, IStateStore, IConfigStore, IContextStore, IMessageStore, IGoalStore, ITeamStore } from './infrastructure/storage/interfaces.js';
import type { IWorkspaceManager } from './infrastructure/workspace/interface.js';
import type { ITemplateEngine } from './infrastructure/template/template-engine.js';
import type { IProcessManager } from './infrastructure/process/process-manager.js';
import type { AdapterRegistry } from './infrastructure/adapters/registry.js';
import type { ISkillLoader } from './infrastructure/skills/skill-loader.js';

import { type GlobalConfig, DEFAULT_GLOBAL_CONFIG } from './domain/global-config.js';
import { Paths } from './infrastructure/storage/paths.js';
import { TaskStore } from './infrastructure/storage/task-store.js';
import { AgentStore } from './infrastructure/storage/agent-store.js';
import { RunStore } from './infrastructure/storage/run-store.js';
import { StateStore } from './infrastructure/storage/state-store.js';
import { ConfigStore } from './infrastructure/storage/config-store.js';
import { GlobalConfigStore } from './infrastructure/storage/global-config-store.js';
import { ContextStore } from './infrastructure/storage/context-store.js';
import { MessageStore } from './infrastructure/storage/message-store.js';
import { GoalStore } from './infrastructure/storage/goal-store.js';
import { TeamStore } from './infrastructure/storage/team-store.js';

import { EventBus } from './application/event-bus.js';
import { TaskService } from './application/task-service.js';
import { AgentService } from './application/agent-service.js';
import { RunService } from './application/run-service.js';
import { MessageService } from './application/message-service.js';
import { GoalService } from './application/goal-service.js';
import { TeamService } from './application/team-service.js';
import { CodeAdmissionService } from './application/code-admission-service.js';
import { IntegrationService } from './application/integration-service.js';
import { LearningService } from './application/learning-service.js';
import { AdmissionStore } from './infrastructure/storage/admission-store.js';
import { OutboxStore } from './infrastructure/integrations/outbox-store.js';
import { WorkflowConfigStore } from './infrastructure/storage/workflow-config-store.js';
import { createLinearTracker } from './infrastructure/integrations/linear/linear-issue-tracker.js';
import type { WorkflowConfig } from './domain/workflow-config.js';
import path from 'node:path';
import yaml from 'js-yaml';

import type { Orchestrator } from './application/orchestrator.js';
import type { DoctorService } from './application/doctor-service.js';

/** Light container — stores + services. No heavy deps (adapters, orchestrator, LiquidJS). */
export interface LightContainer {
  // Context
  context: CliContext;
  paths: Paths;
  config: OrchestratorConfig;

  // Infrastructure — stores only
  taskStore: ITaskStore;
  agentStore: IAgentStore;
  runStore: IRunStore;
  stateStore: IStateStore;
  configStore: IConfigStore;
  globalConfigStore: GlobalConfigStore;
  globalConfig: GlobalConfig;
  contextStore: IContextStore;
  messageStore: IMessageStore;
  goalStore: IGoalStore;
  teamStore: ITeamStore;

  // Application — services only
  eventBus: EventBus;
  taskService: TaskService;
  agentService: AgentService;
  runService: RunService;
  messageService: MessageService;
  goalService: GoalService;
  teamService: TeamService;
  workflowConfig: WorkflowConfig | null;
  admissionStore: AdmissionStore;
  codeIntelligence?: import('./infrastructure/code-intelligence/interface.js').ICodeIntelligence;
  codeAdmissionService: CodeAdmissionService;
  outboxStore: OutboxStore;
  integrationService: IntegrationService;
}

/** Full container — everything from light + orchestrator, adapters, workspace, template. */
export interface Container extends LightContainer {
  processManager: IProcessManager;
  adapterRegistry: AdapterRegistry;
  workspaceManager: IWorkspaceManager;
  templateEngine: ITemplateEngine;
  skillLoader: ISkillLoader;
  doctorService: DoctorService;
  orchestrator: Orchestrator;
}

/**
 * Build a light container (stores + services).
 * Fast — no ProcessManager, no adapters, no LiquidJS, no Orchestrator.
 * Used by read-only commands: task, agent, context, msg, goal, team, logs, status, config.
 */
export async function buildLightContainer(context: CliContext): Promise<LightContainer> {
  const paths = new Paths(context.projectRoot);

  // Infrastructure — stores
  const configStore = new ConfigStore(paths);
  const globalConfigStore = new GlobalConfigStore();

  // Parallel: check init + read config (saves one I/O round trip)
  const [, config] = await Promise.all([
    paths.requireInit(),
    configStore.read(),
  ]);
  const taskStore = new TaskStore(paths);
  const rawTaskSave = taskStore.save.bind(taskStore);
  const rawTaskGet = taskStore.get.bind(taskStore);
  taskStore.save = async (task) => {
    if (task.depends_on.length > 0) {
      const kept: string[] = [];
      for (const ownerId of task.depends_on) {
        const seen = new Set<string>();
        const queue = [ownerId];
        let cycles = false;
        while (queue.length > 0) {
          const id = queue.pop()!;
          if (id === task.id) {
            cycles = true;
            break;
          }
          if (seen.has(id)) continue;
          seen.add(id);
          const other = await rawTaskGet(id);
          if (other) queue.push(...other.depends_on);
        }
        if (!cycles) kept.push(ownerId);
      }
      task.depends_on = kept;
    }
    return rawTaskSave(task);
  };
  const agentStore = new AgentStore(paths);
  const runStore = new RunStore(paths);
  const stateStore = new StateStore(paths);
  const contextStore = new ContextStore(paths);
  const messageStore = new MessageStore(paths);
  const goalStore = new GoalStore(paths);
  const teamStore = new TeamStore(paths);

  // Application — services
  const eventBus = new EventBus();
  const taskService = new TaskService(taskStore, eventBus, config, paths, agentStore);
  const agentService = new AgentService(agentStore, stateStore, eventBus, config);
  const runService = new RunService(runStore, eventBus);
  const messageService = new MessageService(messageStore, agentStore, teamStore, eventBus);
  const goalService = new GoalService(goalStore, eventBus, agentService, taskService, contextStore);
  const teamService = new TeamService(teamStore, agentStore, taskStore, eventBus);
  const workflowConfig = await new WorkflowConfigStore(context.projectRoot).read();
  if (workflowConfig) {
    const { readYaml } = await import('./infrastructure/storage/fs-utils.js');
    const configured = (workflowConfig as { conventions?: { path?: string } }).conventions?.path?.trim();
    const trackedFile = await readYaml<Record<string, unknown>>(
      configured || path.join(context.projectRoot, '.orch', 'conventions.yml'),
    );
    const localFile = await readYaml<Record<string, unknown>>(
      path.join(context.projectRoot, '.orchestry', 'conventions.yml'),
    );
    const overlay = localFile ?? trackedFile;
    if (overlay) {
      const current = ((workflowConfig as { conventions?: Record<string, unknown> }).conventions ?? {}) as Record<string, unknown>;
      (workflowConfig as unknown as { conventions: Record<string, unknown> }).conventions = {
        ...current,
        ...overlay,
        organization: {
          ...((current.organization ?? {}) as Record<string, unknown>),
          ...((overlay.organization ?? {}) as Record<string, unknown>),
        },
        comments: {
          ...((current.comments ?? {}) as Record<string, unknown>),
          ...((overlay.comments ?? {}) as Record<string, unknown>),
        },
      };
    }
  }
  const admissionStore = new AdmissionStore(paths);
  const { createLazyCodeIntelligence } = await import('./infrastructure/code-intelligence/gitnexus-adapter.js');
  const codeIntelligence = createLazyCodeIntelligence(context.projectRoot);
  const rawGetImpact = codeIntelligence.getImpact.bind(codeIntelligence);
  const rawGetSymbolContext = codeIntelligence.getSymbolContext.bind(codeIntelligence);
  const rawDetectChanges = codeIntelligence.detectChanges.bind(codeIntelligence);
  codeIntelligence.getImpact = async (input) => {
    const report = await rawGetImpact({
      ...input,
      direction: input.direction ?? 'upstream',
    });
    const extra: string[] = [];
    const rawObj = report.raw && typeof report.raw === 'object' && !Array.isArray(report.raw)
      ? report.raw as Record<string, unknown>
      : {};
    for (const key of ['processes', 'affected_processes']) {
      const rows = rawObj[key];
      if (!Array.isArray(rows)) continue;
      for (const item of rows) {
        if (typeof item === 'string' && item) extra.push(item);
        else if (item && typeof item === 'object' && !Array.isArray(item)) {
          const row = item as Record<string, unknown>;
          const name = [row['process'], row['label'], row['name'], row['symbol']].find((value) => typeof value === 'string' && value);
          if (typeof name === 'string') extra.push(name);
        }
      }
    }
    const processes = [...new Set([...report.processes, ...extra])];
    if (report.unresolved && report.risk !== 'high' && report.risk !== 'critical') {
      return { ...report, risk: 'unknown', processes };
    }
    return { ...report, processes };
  };
  codeIntelligence.getSymbolContext = async (input) => {
    const context = await rawGetSymbolContext(input);
    const extra: string[] = [];
    const rawObj = context.raw && typeof context.raw === 'object' && !Array.isArray(context.raw)
      ? context.raw as Record<string, unknown>
      : {};
    for (const key of ['processes', 'affected_processes']) {
      const rows = rawObj[key];
      if (!Array.isArray(rows)) continue;
      for (const item of rows) {
        if (typeof item === 'string' && item) extra.push(item);
        else if (item && typeof item === 'object' && !Array.isArray(item)) {
          const row = item as Record<string, unknown>;
          const name = [row['process'], row['label'], row['name'], row['symbol']].find((value) => typeof value === 'string' && value);
          if (typeof name === 'string') extra.push(name);
        }
      }
    }
    return { ...context, processes: [...new Set([...context.processes, ...extra])] };
  };
  codeIntelligence.detectChanges = async (input) => {
    const changeset = await rawDetectChanges(input);
    const extra: string[] = [];
    const rawObj = changeset.raw && typeof changeset.raw === 'object' && !Array.isArray(changeset.raw)
      ? changeset.raw as Record<string, unknown>
      : {};
    for (const key of ['processes', 'affected_processes']) {
      const rows = rawObj[key];
      if (!Array.isArray(rows)) continue;
      for (const item of rows) {
        if (typeof item === 'string' && item) extra.push(item);
        else if (item && typeof item === 'object' && !Array.isArray(item)) {
          const row = item as Record<string, unknown>;
          const name = [row['process'], row['label'], row['name'], row['symbol']].find((value) => typeof value === 'string' && value);
          if (typeof name === 'string') extra.push(name);
        }
      }
    }
    return { ...changeset, processes: [...new Set([...changeset.processes, ...extra])] };
  };
  const rawSearchExisting = codeIntelligence.searchExisting.bind(codeIntelligence);
  codeIntelligence.searchExisting = async (input) => {
    let hits: Array<{ symbol?: string; path: string; kind?: string; score?: number; snippet?: string }> = [];
    try {
      hits = await rawSearchExisting(input);
    } catch {
      hits = [];
    }
    const needle = input.query.trim().toLowerCase();
    if (!needle) return hits;
    const reserved = await admissionStore.listReservations();
    const seen = new Set(hits.map((hit) => `${hit.path}#${hit.symbol ?? ''}`));
    for (const row of reserved) {
      const hay = `${row.path ?? ''} ${row.name ?? ''} ${row.package ?? ''}`.toLowerCase();
      if (!hay.includes(needle)) continue;
      const path = row.path ?? row.package ?? '';
      const key = `${path}#${row.name ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({
        symbol: row.name,
        path,
        kind: row.kind,
        score: 1,
        snippet: `reserved by ${row.task_id}`,
      });
    }
    return hits;
  };
  const workspaceManager: IWorkspaceManager = {
    async prepare() {
      return { path: context.projectRoot };
    },
    async mergeBack() {
      return { success: true };
    },
    async cleanup() {},
    validate() {},
    async getChangedFiles(branch) {
      const diffs = await workspaceManager.getChangedFileDiffs(branch);
      return diffs.map((diff) => diff.path);
    },
    async getChangedFileDiffs(branch) {
      const diffs: Array<{
        path: string;
        status: 'added' | 'modified' | 'deleted' | 'renamed';
        addedLines: string[];
      }> = [];
      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        const { stdout: baseStdout } = await execFileAsync('git', ['merge-base', 'HEAD', branch], {
          cwd: context.projectRoot,
        });
        const mergeBase = baseStdout.trim();
        if (mergeBase) {
          const { stdout: statusStdout } = await execFileAsync(
            'git',
            ['diff', '--name-status', `${mergeBase}...${branch}`],
            { cwd: context.projectRoot },
          );
          for (const line of statusStdout.trim().split('\n').filter(Boolean)) {
            const parts = line.split(/\s+/);
            const codeFlag = parts[0] ?? '';
            const filePath = parts[parts.length - 1] ?? '';
            const status = codeFlag.startsWith('A')
              ? 'added' as const
              : codeFlag.startsWith('D')
                ? 'deleted' as const
                : codeFlag.startsWith('R')
                  ? 'renamed' as const
                  : 'modified' as const;
            let addedLines: string[] = [];
            if (status !== 'deleted' && filePath) {
              const { stdout: patch } = await execFileAsync(
                'git',
                ['diff', '-U0', `${mergeBase}...${branch}`, '--', filePath],
                { cwd: context.projectRoot },
              );
              addedLines = patch
                .split('\n')
                .filter((row) => row.startsWith('+') && !row.startsWith('+++'))
                .map((row) => row.slice(1));
            }
            diffs.push({ path: filePath, status, addedLines });
          }
        }
      } catch {
        // committed range may be missing; still collect working-tree creates
      }
      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const { readFile } = await import('node:fs/promises');
        const execFileAsync = promisify(execFile);
        const seen = new Set(diffs.map((diff) => diff.path.replace(/\\/g, '/')));
        const cwds = [context.projectRoot];
        try {
          const { stdout: listed } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
            cwd: context.projectRoot,
            windowsHide: true,
          });
          let currentWt = '';
          let currentBr = '';
          const consider = (): void => {
            const name = currentBr.replace(/^refs\/heads\//, '');
            if (currentWt && name === branch && !cwds.includes(currentWt)) cwds.push(currentWt);
          };
          for (const line of listed.split('\n')) {
            if (line.startsWith('worktree ')) currentWt = line.slice(9).trim();
            else if (line.startsWith('branch ')) currentBr = line.slice(7).trim();
            else if (!line.trim()) {
              consider();
              currentWt = '';
              currentBr = '';
            }
          }
          consider();
        } catch {
          // repo root only
        }
        for (const cwd of cwds) {
          const { stdout: porcelain } = await execFileAsync('git', ['status', '--porcelain', '-uall'], {
            cwd,
            windowsHide: true,
          });
          for (const row of porcelain.split('\n')) {
            if (row.length < 4) continue;
            const xy = row.slice(0, 2);
            let filePath = row.slice(3).trim().replace(/^"|"$/g, '');
            let status: 'added' | 'modified' | 'deleted' | 'renamed' = 'modified';
            if (xy === '??' || xy.includes('A')) status = 'added';
            else if (xy.includes('D')) status = 'deleted';
            else if (xy.includes('R')) {
              status = 'renamed';
              filePath = filePath.split(' -> ').pop() ?? filePath;
            }
            const norm = filePath.replace(/\\/g, '/');
            if (!norm || seen.has(norm)) continue;
            seen.add(norm);
            let addedLines: string[] = [];
            if (status === 'added') {
              try {
                addedLines = (await readFile(path.join(cwd, filePath), 'utf8')).split('\n');
              } catch {
                addedLines = [];
              }
            } else if (status !== 'deleted') {
              try {
                const { stdout: patch } = await execFileAsync('git', ['diff', '-U0', 'HEAD', '--', filePath], {
                  cwd,
                  windowsHide: true,
                });
                addedLines = patch
                  .split('\n')
                  .filter((row) => row.startsWith('+') && !row.startsWith('+++'))
                  .map((row) => row.slice(1));
              } catch {
                addedLines = [];
              }
            }
            diffs.push({ path: filePath, status, addedLines });
          }
        }
      } catch {
        // keep committed diffs
      }
      return diffs;
    },
  };
  const codeAdmissionService = new CodeAdmissionService(
    admissionStore,
    taskStore,
    eventBus,
    workflowConfig,
    context.projectRoot,
    codeIntelligence,
    workspaceManager,
  );
  const outboxStore = new OutboxStore(paths);
  const tracker = createLinearTracker(workflowConfig);
  if (tracker) {
    const assign = tracker.onTaskAssigned.bind(tracker);
    tracker.onTaskAssigned = async (task, agent) => {
      const stored = await agentStore.get(agent.id);
      return assign(task, stored ?? agent);
    };
    eventBus.on('planning:council_blocked', (event) => {
      void (async () => {
        try {
          for (const task of await taskStore.list()) {
            if (task.plan_id !== event.planId || !task.external?.linear?.id) continue;
            const note = event.reason.trim();
            if (note && !task.feedback?.includes(note)) {
              task.feedback = [task.feedback, note].filter(Boolean).join('\n');
              task.updated_at = new Date().toISOString();
              await taskStore.save(task);
            }
            await tracker.onTaskStatusChanged(task, task.status, task.status);
          }
        } catch {
          return;
        }
      })();
    });
  }
  const integrationService = new IntegrationService(
    taskStore,
    outboxStore,
    eventBus,
    workflowConfig,
    tracker,
  );
  const publishProof = integrationService.publishProof.bind(integrationService);
  integrationService.publishProof = async (task, evidence) => {
    let current = '';
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      const ref = task.proof?.branch || 'HEAD';
      current = (await execFileAsync('git', ['rev-parse', ref], {
        cwd: context.projectRoot,
      })).stdout.trim();
    } catch {
      current = '';
    }
    const next = { ...evidence };
    try {
      const requests = await admissionStore.listRequests({ taskId: task.id });
      const contract = await admissionStore.loadContract(task.id);
      if (next.admission || contract) {
        const extra = (next.admission ?? {
          passed: next.verified === true,
          incomplete: next.verified !== true,
          violations: [],
        }) as {
          passed: boolean;
          incomplete: boolean;
          violations: string[];
          admission_requests?: string[];
          provider?: string;
          repo?: string;
          worktree?: string;
          index_commit?: string;
          index_current?: boolean;
          existing_candidates?: number;
          existing_candidates_considered?: number;
          reused_symbols?: string[];
          modified_existing_symbols?: string[];
          approved_new_files?: string[];
          actual_new_files?: string[];
          approved_new_symbols?: string[];
          actual_new_symbols?: string[];
          approved_dependencies?: string[];
          actual_new_dependencies?: string[];
          affected_processes?: string[];
          impact_risk?: string;
          audit_complete?: boolean;
        };
        extra.admission_requests = requests.map((item) => item.id);
        extra.provider = 'gitnexus';
        extra.worktree = task.workspace;
        if (contract?.code_index.repo) extra.repo = contract.code_index.repo;
        if (extra.index_commit === undefined && contract?.code_index.index_commit) {
          extra.index_commit = contract.code_index.index_commit;
        }
        if (extra.index_current === undefined && contract) {
          extra.index_current = contract.code_index.index_current;
        }
        if (extra.existing_candidates === undefined && contract) {
          extra.existing_candidates = contract.existing_code_considered.length;
        }
        extra.existing_candidates_considered = extra.existing_candidates;
        if (extra.reused_symbols === undefined && contract) {
          extra.reused_symbols = contract.existing_code_considered
            .filter((item) => item.decision === 'reuse' || item.decision === 'modify')
            .map((item) => item.symbol ?? item.path);
        }
        if (extra.modified_existing_symbols === undefined && contract) {
          extra.modified_existing_symbols = contract.allowed_existing_edits.map((item) => item.symbol);
        }
        if (extra.approved_new_files === undefined && contract) {
          extra.approved_new_files = contract.allowed_new_files.map((item) => item.path);
        }
        if (extra.approved_new_symbols === undefined && contract) {
          extra.approved_new_symbols = contract.allowed_new_symbols.map((item) => item.name);
        }
        if (extra.approved_dependencies === undefined && contract) {
          extra.approved_dependencies = contract.allowed_dependencies.map((item) => item.package);
        }
        if (extra.impact_risk === undefined && contract) {
          const rank: Record<string, number> = { low: 1, medium: 2, unknown: 3, high: 4, critical: 5 };
          let best = 0;
          for (const risk of contract.allowed_existing_edits.map((item) => item.impact?.risk).filter((item): item is string => Boolean(item))) {
            const score = rank[risk] ?? 0;
            if (score > best) {
              best = score;
              extra.impact_risk = risk;
            }
          }
        }
        const processes = task.feedback
          ?.split('\n')
          .find((line) => /^admission: processes:/i.test(line))
          ?.replace(/^admission: processes:\s*/i, '')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
        if ((!extra.affected_processes || extra.affected_processes.length === 0) && processes?.length) {
          extra.affected_processes = processes;
        }
        extra.audit_complete = extra.incomplete !== true;
        const mediumEdit = Boolean(contract?.allowed_existing_edits.some((item) => /^medium$/i.test(item.impact?.risk ?? ''))
          || contract?.existing_code_considered.some((item) => /impact MEDIUM\b/i.test(item.reason)));
        const testsOk = (next.checks ?? []).some((check) =>
          /test|typecheck|vitest|jest|coverage/i.test(check.name) && check.status === 'passed',
        );
        if (mediumEdit && !testsOk) {
          next.verified = false;
          delete next.verified_at;
          extra.incomplete = true;
          extra.audit_complete = false;
          extra.passed = false;
          if (!extra.violations.some((item) => /MEDIUM impact edits require tests/i.test(item))) {
            extra.violations = [...extra.violations, 'MEDIUM impact edits require tests for dependents'];
          }
        }
        if (!extra.actual_new_dependencies) {
          const deps = new Set<string>();
          try {
            const { execFile } = await import('node:child_process');
            const { promisify } = await import('node:util');
            const execFileAsync = promisify(execFile);
            const ref = task.proof?.branch?.trim();
            let range = 'HEAD';
            if (ref) {
              try {
                const { stdout: base } = await execFileAsync('git', ['merge-base', 'HEAD', ref], {
                  cwd: context.projectRoot,
                  timeout: 10_000,
                  windowsHide: true,
                });
                range = base.trim() ? `${base.trim()}...${ref}` : ref;
              } catch {
                range = ref;
              }
            }
            const { stdout } = await execFileAsync('git', ['diff', '-U0', range, '--', 'package.json'], {
              cwd: context.projectRoot,
              timeout: 10_000,
              windowsHide: true,
            });
            for (const line of stdout.split('\n')) {
              const match = /^\+\s*"([^"]+)"\s*:\s*"/.exec(line);
              const pkg = match?.[1];
              if (!pkg || pkg.startsWith('@types/') || pkg === 'name' || pkg === 'version' || pkg === 'description') continue;
              deps.add(pkg);
            }
          } catch {
            // Fail-open: approved_dependencies still render.
          }
          extra.actual_new_dependencies = [...deps];
        }
        try {
          const status = await codeIntelligence.getRepositoryStatus({
            repository_root: context.projectRoot,
            worktree_path: task.workspace,
            repo: extra.repo,
          });
          if (!extra.repo && status.repo) extra.repo = status.repo;
          if (!extra.index_commit && status.index_commit) extra.index_commit = status.index_commit;
          extra.index_current = status.current;
          if (status.available && status.current === false) {
            next.verified = false;
            delete next.verified_at;
          }
        } catch {
          // keep contract index if live status is unavailable
        }
        next.admission = extra;
      }
    } catch {
      // keep proof publish if the ledger is unreadable
    }
    if (next.verified && current && next.head_sha && current !== next.head_sha) {
      next.verified = false;
    }
    if (task.proof?.verified === true && task.proof.head_sha && current && current !== task.proof.head_sha) {
      task.proof = { ...task.proof, verified: false };
      task.updated_at = new Date().toISOString();
      await taskStore.save(task);
    }
    return publishProof(task, next);
  };
  const recordReview = integrationService.recordReview.bind(integrationService);
  integrationService.recordReview = async (task, review) => {
    let next = review;
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: context.projectRoot })).stdout.trim();
      const branch = task.proof?.branch?.trim();
      const branchSha = branch
        ? (await execFileAsync('git', ['rev-parse', branch], { cwd: context.projectRoot })).stdout.trim()
        : '';
      const incoming = review.commit_sha?.trim() ?? '';
      if (branchSha && (!incoming || incoming === head) && incoming !== branchSha) {
        next = { ...review, commit_sha: branchSha };
      }
    } catch {
      next = review;
    }
    if (!next.commit_sha?.trim()) {
      next = {
        ...next,
        commit_sha: '',
        verdict: 'failed',
        summary: next.summary || 'Review missing commit SHA — fail closed.',
      };
    }
    return recordReview(task, next);
  };
  eventBus.on('task:created', (event) => {
    void (async () => {
      const contract = await codeAdmissionService.ensureFastPathContract(event.task);
      if (!contract || !event.task.plan_id || contract.plan_digest) return;
      try {
        const { readJson } = await import('./infrastructure/storage/fs-utils.js');
        const { planDigest } = await import('./domain/plan.js');
        const plan = await readJson<{ digest?: string; title?: string; units?: Array<{ title: string }> }>(
          paths.planManifestPath(event.task.plan_id),
        );
        const digest = plan?.digest || (plan?.title && plan.units ? planDigest(plan.title, plan.units) : '');
        if (!digest) return;
        contract.plan_digest = digest;
        await admissionStore.saveContract(contract);
      } catch {
        // plan manifest is optional until import writes it
      }
    })();
  });
  const auditTask = codeAdmissionService.auditTask.bind(codeAdmissionService);
  codeAdmissionService.auditTask = async (task) => {
    const pending: Array<{ type: 'code_admission:audit_completed'; taskId: string; passed: boolean; violations: string[] }> = [];
    const origEmit = eventBus.emit.bind(eventBus);
    eventBus.emit = ((event: { type: string }) => {
      if (event.type === 'code_admission:audit_completed') {
        pending.push(event as typeof pending[number]);
        return;
      }
      origEmit(event as Parameters<typeof origEmit>[0]);
    }) as typeof eventBus.emit;
    let result: Awaited<ReturnType<typeof auditTask>>;
    try {
      result = await auditTask(task);
    } finally {
      eventBus.emit = origEmit;
    }
    for (const event of pending) {
      origEmit({
        ...event,
        deleted_symbols: result.deleted_symbols,
        processes: result.processes,
      });
    }
    const reported = [
      result.deleted_symbols?.length ? `admission: deleted symbols: ${result.deleted_symbols.join(', ')}` : '',
      result.processes?.length ? `admission: processes: ${result.processes.join(', ')}` : '',
    ].filter(Boolean);
    if ((workflowConfig as { conventions?: { enabled?: boolean } } | null)?.conventions?.enabled === true) {
      const conv = result.violations
        .filter((item) => item.message.startsWith('conventions:'))
        .map((item) => item.message);
      eventBus.emit(conv.length > 0
        ? { type: 'workspace:conventions_failed', taskId: task.id, violations: conv }
        : { type: 'workspace:conventions_passed', taskId: task.id });
      if (conv.length > 0) {
        reported.push(...conv.filter((note) => !task.feedback?.includes(note)));
      }
    }
    const missing = reported.filter((note) => !task.feedback?.includes(note));
    if (missing.length > 0) {
      task.feedback = [task.feedback, ...missing].filter(Boolean).join('\n');
      task.updated_at = new Date().toISOString();
      await taskStore.save(task);
    }
    return result;
  };
  const applyReuse = codeAdmissionService.applyReuseCreates.bind(codeAdmissionService);
  codeAdmissionService.applyReuseCreates = async (task, reuse) => {
    const authorized = reuse.incomplete ? { ...reuse, proposed_creates: [] } : reuse;
    const contract = await applyReuse(task, authorized);
    if (!contract) return null;
    contract.allowed_existing_edits = contract.allowed_existing_edits.filter((item) => {
      if (item.impact?.risk === 'high' || item.impact?.risk === 'critical' || item.impact?.risk === 'unknown') {
        return false;
      }
      const related = reuse.candidates.find((row) => row.path === item.path && (row.symbol ?? row.path) === item.symbol);
      const edit = reuse.recommended_edits.find((row) => row.path === item.path && (row.symbol ?? row.path) === item.symbol);
      return !/impact (HIGH|CRITICAL|UNKNOWN)/.test(`${edit?.reason ?? ''} ${related?.reason ?? ''}`);
    });
    for (const candidate of reuse.candidates) {
      if (!contract.existing_code_considered.some((item) => item.path === candidate.path && item.symbol === candidate.symbol)) {
        contract.existing_code_considered.push(candidate);
      }
    }
    for (const edit of reuse.recommended_edits) {
      const candidate = reuse.candidates.find((item) => item.path === edit.path && (item.symbol ?? item.path) === (edit.symbol ?? edit.path));
      if (/impact (HIGH|CRITICAL|UNKNOWN)/.test(`${edit.reason} ${candidate?.reason ?? ''}`)) {
        continue;
      }
      if (contract.allowed_existing_edits.some((item) => item.path === edit.path && item.symbol === (edit.symbol ?? edit.path))) {
        continue;
      }
      const impactHit = /impact (LOW|MEDIUM|HIGH|CRITICAL|UNKNOWN), (\d+) dependents, processes: ([^)]*)/.exec(edit.reason);
      contract.allowed_existing_edits.push({
        symbol: edit.symbol ?? edit.path,
        path: edit.path,
        expected_change: edit.reason,
        impact: impactHit
          ? {
              risk: impactHit[1]!.toLowerCase(),
              direct_dependents: Number(impactHit[2]),
              processes: impactHit[3] && impactHit[3] !== 'none' ? impactHit[3].split(', ') : [],
            }
          : undefined,
      });
    }
    if (reuse.incomplete) {
      contract.notes = [
        ...(contract.notes ?? []),
        'GitNexus reuse is incomplete — proposed creates were not authorized.',
      ];
    }
    if (task.plan_id && !contract.plan_digest) {
      try {
        const { readJson } = await import('./infrastructure/storage/fs-utils.js');
        const { planDigest } = await import('./domain/plan.js');
        const plan = await readJson<{ digest?: string; title?: string; units?: Array<{ title: string }> }>(
          paths.planManifestPath(task.plan_id),
        );
        const digest = plan?.digest || (plan?.title && plan.units ? planDigest(plan.title, plan.units) : '');
        if (digest) contract.plan_digest = digest;
      } catch {
        // plan manifest is optional until import writes it
      }
    }
    await admissionStore.saveContract(contract);
    return contract;
  };
  integrationService.subscribe();
  if (workflowConfig?.linear?.enabled === true && integrationService.enabled()) {
    void (async () => {
      try {
        const queued = new Set(
          [
            ...await outboxStore.list('pending'),
            ...await outboxStore.list('failed'),
          ]
            .filter((entry) => entry.kind.startsWith('linear.'))
            .map((entry) => entry.task_id),
        );
        for (const task of await taskStore.list()) {
          if (task.status === 'cancelled' || task.external?.linear?.id || queued.has(task.id)) continue;
          try {
            await integrationService.retry(task.id);
          } catch (err) {
            eventBus.emit({
              type: 'integration:sync_failed',
              provider: 'linear',
              taskId: task.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } catch {
        return;
      }
    })();
  }
  const learningService = new LearningService(paths, eventBus);
  const recordLearning = learningService.record.bind(learningService);
  learningService.record = async (goal) => {
    if (/^task\s+\S+\s+passed\.?$/i.test(goal.title.trim())) {
      return {
        goal_id: goal.id,
        eligible: false,
        reason: 'Status-only learning is not reusable architecture',
        created_at: new Date().toISOString(),
        committed: false,
      };
    }
    const record = await recordLearning(goal);
    try {
      const hits = await codeIntelligence.searchExisting({
        query: goal.title,
        worktree: context.projectRoot,
      });
      const seams = hits
        .filter((hit) => hit.path || hit.symbol)
        .slice(0, 8);
      if (seams.length === 0) return record;
      const day = record.created_at.slice(0, 10);
      const relative = path.join('docs', 'solutions', `${day}-${goal.id}.md`);
      const file = path.join(paths.repoRoot, relative);
      const { readFile, appendFile } = await import('node:fs/promises');
      const current = await readFile(file, 'utf8');
      if (current.includes('## GitNexus architecture seams')) return record;
      await appendFile(
        file,
        [
          '',
          '## GitNexus architecture seams',
          '',
          ...seams.map((hit) => `- \`${hit.path}${hit.symbol ? `#${hit.symbol}` : ''}\``),
          '',
        ].join('\n'),
      );
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      try {
        await execFileAsync('git', ['add', '--', relative], { cwd: paths.repoRoot, windowsHide: true });
        await execFileAsync('git', ['commit', '-m', `docs: record learning seams for ${goal.id}`], {
          cwd: paths.repoRoot,
          windowsHide: true,
        });
        record.committed = true;
      } catch {
        // learning file still has seams even if git is unavailable
      }
    } catch {
      // keep the original learning note if GitNexus is unavailable
    }
    return record;
  };
  learningService.subscribe();

  return {
    context,
    paths,
    config,
    taskStore,
    agentStore,
    runStore,
    stateStore,
    configStore,
    globalConfigStore,
    globalConfig: DEFAULT_GLOBAL_CONFIG,
    contextStore,
    messageStore,
    goalStore,
    teamStore,
    eventBus,
    taskService,
    agentService,
    runService,
    messageService,
    goalService,
    teamService,
    workflowConfig,
    admissionStore,
    codeIntelligence,
    codeAdmissionService,
    outboxStore,
    integrationService,
  };
}

/**
 * Build a full container (light + orchestrator + adapters + template).
 * Used by: run, tui, doctor.
 */
export async function buildFullContainer(context: CliContext): Promise<Container> {
  const light = await buildLightContainer(context);

  // Read global config (needed by TUI for activity_filter, notifications)
  const globalConfig = await light.globalConfigStore.read();
  light.globalConfig = globalConfig;

  // Dynamic imports — avoid loading heavy deps at top level
  const [
    { ProcessManager },
    { AdapterRegistry },
    { ClaudeAdapter },
    { CodexAdapter },
    { CursorAdapter },
    { ShellAdapter },
    { OpenCodeAdapter },
    { PiAdapter },
    { GrokAdapter },
    { AntigravityAdapter },
    { WorkspaceManager },
    { LiquidTemplateEngine },
    { SkillLoader },
    { Orchestrator },
    { DoctorService },
  ] = await Promise.all([
    import('./infrastructure/process/process-manager.js'),
    import('./infrastructure/adapters/registry.js'),
    import('./infrastructure/adapters/claude.js'),
    import('./infrastructure/adapters/codex.js'),
    import('./infrastructure/adapters/cursor.js'),
    import('./infrastructure/adapters/shell.js'),
    import('./infrastructure/adapters/opencode.js'),
    import('./infrastructure/adapters/pi.js'),
    import('./infrastructure/adapters/grok.js'),
    import('./infrastructure/adapters/antigravity.js'),
    import('./infrastructure/workspace/workspace-manager.js'),
    import('./infrastructure/template/template-engine.js'),
    import('./infrastructure/skills/skill-loader.js'),
    import('./application/orchestrator.js'),
    import('./application/doctor-service.js'),
  ]);

  const processManager = new ProcessManager();
  const innerTemplateEngine = new LiquidTemplateEngine();
  const conventionsSeen = new WeakSet<object>();
  const templateEngine: ITemplateEngine = {
    async render(template, promptContext) {
      const body = await innerTemplateEngine.render(template, promptContext);
      if (conventionsSeen.has(promptContext)) return body;
      conventionsSeen.add(promptContext);
      const extras: string[] = [body];
      const task = await light.taskStore.get(promptContext.task.id).catch(() => undefined);
      let baseSha = '';
      try {
        const contract = await light.codeAdmissionService.getContract(promptContext.task.id);
        baseSha = contract?.base_sha ?? '';
      } catch {
        baseSha = '';
      }
      let repo = '';
      let indexCommit = '';
      try {
        const status = await light.codeIntelligence?.getRepositoryStatus({
          repository_root: context.projectRoot,
          worktree_path: promptContext.workspace_path,
        });
        repo = status?.repo ?? '';
        indexCommit = status?.index_commit ?? '';
      } catch {
        repo = '';
        indexCommit = '';
      }
      extras.push(
        '',
        '## Worker code context',
        `repository_root: ${context.projectRoot}`,
        `worktree_path: ${promptContext.workspace_path}`,
        `branch: ${task?.proof?.branch ?? ''}`,
        `base_sha: ${baseSha}`,
        `head_sha: ${task?.proof?.head_sha ?? ''}`,
        `gitnexus.repo: ${repo}`,
        `gitnexus.worktree: ${promptContext.workspace_path}`,
        `gitnexus.index_commit: ${indexCommit}`,
      );
      try {
        const { listLearnings, renderLearningContext } = await import('./application/learning-reader.js');
        const learningBlock = renderLearningContext(await listLearnings(context.projectRoot));
        if (learningBlock) extras.push('', learningBlock);
      } catch {
        // fail-open: missing docs/solutions must not block dispatch
      }
      const rules = (light.workflowConfig as {
        conventions?: {
          enabled?: boolean;
          organization?: {
            allowed_new_file_roots?: string[];
            forbidden_new_file_globs?: string[];
            max_new_files_per_task?: number;
          };
          comments?: {
            header_max_lines?: number;
            header_min_lines?: number;
            allowed_inline_patterns?: string[];
          };
        };
      } | null)?.conventions;
      if (rules?.enabled === true) {
        const rendered = yaml.dump(
          {
            organization: rules.organization ?? {},
            comments: rules.comments ?? {},
          },
          { indent: 2, lineWidth: 120, noRefs: true, sortKeys: false },
        ).trim();
        extras.push(
          '',
          '## Project Conventions (enforced at merge)',
          '',
          'These rules are mechanical. Violating them blocks merge-back.',
          '',
          rendered,
          '',
          'If you need a new file or a new top-level function, request it with `orch admission request`.',
        );
      }
      return extras.join('\n');
    },
  };
  const skillLoader = new SkillLoader();
  const workspaceManager = new WorkspaceManager(
    context.projectRoot,
    light.paths.root,
    processManager,
  );
  const mergeBack = workspaceManager.mergeBack.bind(workspaceManager);
  workspaceManager.mergeBack = async (branch) => {
    const tasks = await light.taskStore.list();
    const task = tasks.find((item) => item.proof?.branch === branch);
    let current = '';
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      current = (await execFileAsync('git', ['rev-parse', branch], {
        cwd: context.projectRoot,
      })).stdout.trim();
    } catch {
      current = '';
    }
    if (task?.proof?.head_sha && current && current !== task.proof.head_sha) {
      if (task.proof.verified === true) {
        task.proof = { ...task.proof, verified: false };
        task.updated_at = new Date().toISOString();
        await light.taskStore.save(task);
      }
      return {
        success: false,
        conflictInfo: 'PROOF STALE: branch HEAD moved; rebuild proof for the new commit',
      };
    }
    const sha = current || task?.proof?.head_sha;
    if ((task?.reviews ?? []).some((review) => (
      (!sha || review.commit_sha === sha)
      && (review.verdict === 'changes_requested' || review.verdict === 'failed')
    ))) {
      return {
        success: false,
        conflictInfo: 'REVIEW BLOCKED: HEAD still has changes_requested or failed',
      };
    }
    if (task && light.codeAdmissionService.enabled()) {
      const contract = await light.admissionStore.loadContract(task.id);
      const mediumEdit = Boolean(contract?.allowed_existing_edits.some((item) => /^medium$/i.test(item.impact?.risk ?? ''))
        || contract?.existing_code_considered.some((item) => /impact MEDIUM\b/i.test(item.reason)));
      const testsOk = (task.review_results ?? []).some((result) =>
        (result.criterion === 'test_pass' || result.criterion === 'typecheck' || /test|typecheck|vitest|jest|coverage/i.test(result.criterion))
        && result.passed,
      );
      if (mediumEdit && !testsOk) {
        return {
          success: false,
          conflictInfo: 'ADMISSION BLOCKED: MEDIUM impact edits require tests for dependents',
        };
      }
      const audit = await light.codeAdmissionService.auditTask(task);
      if (!audit.passed || audit.incomplete) {
        return {
          success: false,
          conflictInfo: `ADMISSION BLOCKED: ${audit.violations.map((item) => item.message).join('; ') || 'failed'}`,
        };
      }
    }
    return mergeBack(branch);
  };
  const committedFileDiffs = workspaceManager.getChangedFileDiffs.bind(workspaceManager);
  workspaceManager.getChangedFileDiffs = async (branch) => {
    const diffs = [...await committedFileDiffs(branch)];
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const { readFile } = await import('node:fs/promises');
      const execFileAsync = promisify(execFile);
      const seen = new Set(diffs.map((diff) => diff.path.replace(/\\/g, '/')));
      const cwds = [context.projectRoot];
      try {
        const { stdout: listed } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], {
          cwd: context.projectRoot,
          windowsHide: true,
        });
        let currentWt = '';
        let currentBr = '';
        const consider = (): void => {
          const name = currentBr.replace(/^refs\/heads\//, '');
          if (currentWt && name === branch && !cwds.includes(currentWt)) cwds.push(currentWt);
        };
        for (const line of listed.split('\n')) {
          if (line.startsWith('worktree ')) currentWt = line.slice(9).trim();
          else if (line.startsWith('branch ')) currentBr = line.slice(7).trim();
          else if (!line.trim()) {
            consider();
            currentWt = '';
            currentBr = '';
          }
        }
        consider();
      } catch {
        // repo root only
      }
      for (const cwd of cwds) {
        const { stdout: porcelain } = await execFileAsync('git', ['status', '--porcelain', '-uall'], {
          cwd,
          windowsHide: true,
        });
        for (const row of porcelain.split('\n')) {
          if (row.length < 4) continue;
          const xy = row.slice(0, 2);
          let filePath = row.slice(3).trim().replace(/^"|"$/g, '');
          let status: 'added' | 'modified' | 'deleted' | 'renamed' = 'modified';
          if (xy === '??' || xy.includes('A')) status = 'added';
          else if (xy.includes('D')) status = 'deleted';
          else if (xy.includes('R')) {
            status = 'renamed';
            filePath = filePath.split(' -> ').pop() ?? filePath;
          }
          const norm = filePath.replace(/\\/g, '/');
          if (!norm || seen.has(norm)) continue;
          seen.add(norm);
          let addedLines: string[] = [];
          if (status === 'added') {
            try {
              addedLines = (await readFile(path.join(cwd, filePath), 'utf8')).split('\n');
            } catch {
              addedLines = [];
            }
          } else if (status !== 'deleted') {
            try {
              const { stdout: patch } = await execFileAsync('git', ['diff', '-U0', 'HEAD', '--', filePath], {
                cwd,
                windowsHide: true,
              });
              addedLines = patch
                .split('\n')
                .filter((row) => row.startsWith('+') && !row.startsWith('+++'))
                .map((row) => row.slice(1));
            } catch {
              addedLines = [];
            }
          }
          diffs.push({ path: filePath, status, addedLines });
        }
      }
    } catch {
      // keep committed diffs
    }
    return diffs;
  };

  // Adapter registry
  const adapterRegistry = new AdapterRegistry();
  adapterRegistry.register(new ClaudeAdapter(processManager));
  adapterRegistry.register(new CodexAdapter(processManager));
  adapterRegistry.register(new CursorAdapter(processManager));
  adapterRegistry.register(new ShellAdapter(processManager));
  adapterRegistry.register(new OpenCodeAdapter(processManager));
  adapterRegistry.register(new PiAdapter(processManager));
  adapterRegistry.register(new GrokAdapter(processManager));
  adapterRegistry.register(new AntigravityAdapter(processManager));

  const doctorService = new DoctorService(adapterRegistry, processManager, context.projectRoot);
  const { AdapterAdmissionReviewer } = await import('./application/admission-reviewer.js');
  const admissionReviewer = new AdapterAdmissionReviewer(
    (kind) => (kind === 'codex' ? adapterRegistry.get('codex') : adapterRegistry.get('claude')),
    context.projectRoot,
  );
  const codeAdmissionService = new CodeAdmissionService(
    light.admissionStore,
    light.taskStore,
    light.eventBus,
    light.workflowConfig,
    context.projectRoot,
    light.codeIntelligence,
    workspaceManager,
    admissionReviewer,
  );
  light.codeAdmissionService = codeAdmissionService;
  const auditTask = codeAdmissionService.auditTask.bind(codeAdmissionService);
  codeAdmissionService.auditTask = async (task) => {
    const pending: Array<{ type: 'code_admission:audit_completed'; taskId: string; passed: boolean; violations: string[] }> = [];
    const origEmit = light.eventBus.emit.bind(light.eventBus);
    light.eventBus.emit = ((event: { type: string }) => {
      if (event.type === 'code_admission:audit_completed') {
        pending.push(event as typeof pending[number]);
        return;
      }
      origEmit(event as Parameters<typeof origEmit>[0]);
    }) as typeof light.eventBus.emit;
    let result: Awaited<ReturnType<typeof auditTask>>;
    try {
      result = await auditTask(task);
    } finally {
      light.eventBus.emit = origEmit;
    }
    for (const event of pending) {
      origEmit({
        ...event,
        deleted_symbols: result.deleted_symbols,
        processes: result.processes,
      });
    }
    const reported = [
      result.deleted_symbols?.length ? `admission: deleted symbols: ${result.deleted_symbols.join(', ')}` : '',
      result.processes?.length ? `admission: processes: ${result.processes.join(', ')}` : '',
    ].filter(Boolean);
    if ((light.workflowConfig as { conventions?: { enabled?: boolean } } | null)?.conventions?.enabled === true) {
      const conv = result.violations
        .filter((item) => item.message.startsWith('conventions:'))
        .map((item) => item.message);
      light.eventBus.emit(conv.length > 0
        ? { type: 'workspace:conventions_failed', taskId: task.id, violations: conv }
        : { type: 'workspace:conventions_passed', taskId: task.id });
      if (conv.length > 0) {
        reported.push(...conv.filter((note) => !task.feedback?.includes(note)));
      }
    }
    const missing = reported.filter((note) => !task.feedback?.includes(note));
    if (missing.length > 0) {
      task.feedback = [task.feedback, ...missing].filter(Boolean).join('\n');
      task.updated_at = new Date().toISOString();
      await light.taskStore.save(task);
    }
    return result;
  };
  const applyReuse = codeAdmissionService.applyReuseCreates.bind(codeAdmissionService);
  codeAdmissionService.applyReuseCreates = async (task, reuse) => {
    const authorized = reuse.incomplete ? { ...reuse, proposed_creates: [] } : reuse;
    const contract = await applyReuse(task, authorized);
    if (!contract) return null;
    contract.allowed_existing_edits = contract.allowed_existing_edits.filter((item) => {
      if (item.impact?.risk === 'high' || item.impact?.risk === 'critical' || item.impact?.risk === 'unknown') {
        return false;
      }
      const related = reuse.candidates.find((row) => row.path === item.path && (row.symbol ?? row.path) === item.symbol);
      const edit = reuse.recommended_edits.find((row) => row.path === item.path && (row.symbol ?? row.path) === item.symbol);
      return !/impact (HIGH|CRITICAL|UNKNOWN)/.test(`${edit?.reason ?? ''} ${related?.reason ?? ''}`);
    });
    for (const candidate of reuse.candidates) {
      if (!contract.existing_code_considered.some((item) => item.path === candidate.path && item.symbol === candidate.symbol)) {
        contract.existing_code_considered.push(candidate);
      }
    }
    for (const edit of reuse.recommended_edits) {
      const candidate = reuse.candidates.find((item) => item.path === edit.path && (item.symbol ?? item.path) === (edit.symbol ?? edit.path));
      if (/impact (HIGH|CRITICAL|UNKNOWN)/.test(`${edit.reason} ${candidate?.reason ?? ''}`)) {
        continue;
      }
      if (contract.allowed_existing_edits.some((item) => item.path === edit.path && item.symbol === (edit.symbol ?? edit.path))) {
        continue;
      }
      const impactHit = /impact (LOW|MEDIUM|HIGH|CRITICAL|UNKNOWN), (\d+) dependents, processes: ([^)]*)/.exec(edit.reason);
      contract.allowed_existing_edits.push({
        symbol: edit.symbol ?? edit.path,
        path: edit.path,
        expected_change: edit.reason,
        impact: impactHit
          ? {
              risk: impactHit[1]!.toLowerCase(),
              direct_dependents: Number(impactHit[2]),
              processes: impactHit[3] && impactHit[3] !== 'none' ? impactHit[3].split(', ') : [],
            }
          : undefined,
      });
    }
    if (reuse.incomplete) {
      contract.notes = [
        ...(contract.notes ?? []),
        'GitNexus reuse is incomplete — proposed creates were not authorized.',
      ];
    }
    if (task.plan_id && !contract.plan_digest) {
      try {
        const { readJson } = await import('./infrastructure/storage/fs-utils.js');
        const { planDigest } = await import('./domain/plan.js');
        const plan = await readJson<{ digest?: string; title?: string; units?: Array<{ title: string }> }>(
          light.paths.planManifestPath(task.plan_id),
        );
        const digest = plan?.digest || (plan?.title && plan.units ? planDigest(plan.title, plan.units) : '');
        if (digest) contract.plan_digest = digest;
      } catch {
        // plan manifest is optional until import writes it
      }
    }
    await light.admissionStore.saveContract(contract);
    return contract;
  };

  subscribeLinearOutboxDrain(light);

  const orchestrator = new Orchestrator({
    taskStore: light.taskStore,
    agentStore: light.agentStore,
    runStore: light.runStore,
    stateStore: light.stateStore,
    adapterRegistry,
    workspaceManager,
    templateEngine,
    processManager,
    eventBus: light.eventBus,
    taskService: light.taskService,
    agentService: light.agentService,
    runService: light.runService,
    contextStore: light.contextStore,
    messageService: light.messageService,
    goalStore: light.goalStore,
    skillLoader,
    codeAdmissionService,
    integrationService: light.integrationService,
    config: light.config,
    projectRoot: context.projectRoot,
    lockPath: light.paths.lockPath,
  });

  return {
    ...light,
    processManager,
    adapterRegistry,
    workspaceManager,
    templateEngine,
    skillLoader,
    doctorService,
    orchestrator,
  };
}

/**
 * @deprecated Use buildLightContainer or buildFullContainer directly.
 * Kept for backward compatibility with tests.
 */
export async function buildContainer(context: CliContext): Promise<Container> {
  return buildFullContainer(context);
}

/** Spec §6.3: run / tui / serve ticks retry Linear outbox with the same backoff as CLI drain. */
function subscribeLinearOutboxDrain(container: LightContainer): void {
  let draining = false;
  container.eventBus.on('orchestrator:tick', () => {
    if (draining) return;
    draining = true;
    void drainDueLinearOutbox(container)
      .then(async () => {
        try {
          const { execFile } = await import('node:child_process');
          const { promisify } = await import('node:util');
          const execFileAsync = promisify(execFile);
          for (const task of await container.taskStore.list()) {
            if (!task.proof?.verified || !task.proof.head_sha) continue;
            let current = '';
            try {
              current = (await execFileAsync('git', ['rev-parse', task.proof.branch || 'HEAD'], {
                cwd: container.context.projectRoot,
              })).stdout.trim();
            } catch {
              continue;
            }
            if (current && current !== task.proof.head_sha) {
              task.proof = { ...task.proof, verified: false };
              task.updated_at = new Date().toISOString();
              await container.taskStore.save(task);
            }
          }
        } catch {
          // temp dirs can disappear before this finishes
        }
        if (container.workflowConfig?.linear?.enabled !== true) return;
        if (!container.integrationService.enabled()) return;
        const queued = new Set(
          [
            ...await container.outboxStore.list('pending'),
            ...await container.outboxStore.list('failed'),
          ]
            .filter((entry) => entry.kind.startsWith('linear.'))
            .map((entry) => entry.task_id),
        );
        for (const task of await container.taskStore.list()) {
          if (task.status === 'cancelled' || task.external?.linear?.id || queued.has(task.id)) continue;
          try {
            await container.integrationService.retry(task.id);
          } catch (err) {
            container.eventBus.emit({
              type: 'integration:sync_failed',
              provider: 'linear',
              taskId: task.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      })
      .finally(() => {
        draining = false;
      });
  });
}

async function drainDueLinearOutbox(container: LightContainer): Promise<void> {
  if (container.workflowConfig?.linear?.enabled !== true) return;
  if (!container.integrationService.enabled()) return;
  const { outboxRetryDue } = await import('./infrastructure/integrations/outbox-store.js');
  const entries = [
    ...await container.outboxStore.list('pending'),
    ...await container.outboxStore.list('failed'),
  ];
  for (const entry of entries) {
    if (!entry.kind.startsWith('linear.')) continue;
    if (!outboxRetryDue(entry)) continue;
    try {
      if (entry.kind === 'linear.proof' || entry.kind === 'linear.pr') {
        const task = await container.taskStore.get(entry.task_id);
        if (!task) throw new Error(`Task not found: ${entry.task_id}`);
        if (entry.kind === 'linear.proof') {
          await container.integrationService.publishProof(task, {
            task_id: task.id,
            plan_id: task.plan_id,
            plan_unit_id: task.plan_unit_id,
            branch: task.proof?.branch,
            pr_url: task.proof?.pr_url ?? task.external?.github?.pr_url,
            head_sha: task.proof?.head_sha,
            files_changed: task.proof?.files_changed ?? [],
            checks: [],
            reviews: task.reviews ?? [],
            acceptance_criteria: [],
            verified: task.proof?.verified === true,
          });
        } else if (task.external?.github?.pr_url) {
          await container.integrationService.linkPullRequest(
            task,
            task.external.github.pr_url,
            task.external.github.pr_number,
          );
        }
        entry.status = 'done';
        delete entry.last_error;
        await container.outboxStore.save(entry);
        continue;
      }
      await container.integrationService.retry(entry.task_id);
    } catch (err) {
      container.eventBus.emit({
        type: 'integration:sync_failed',
        provider: 'linear',
        taskId: entry.task_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
