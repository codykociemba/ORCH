/**
 * Code admission — watcher-owned policy over GitNexus + the global ledger.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { EventBus } from './event-bus.js';
import type { ITaskStore } from '../infrastructure/storage/interfaces.js';
import { AdmissionStore } from '../infrastructure/storage/admission-store.js';
import type { ICodeIntelligence } from '../infrastructure/code-intelligence/interface.js';
import type { IWorkspaceManager, ChangedFileDiff } from '../infrastructure/workspace/interface.js';
import type { Task } from '../domain/task.js';
import type { WorkflowConfig } from '../domain/workflow-config.js';
import { isAdmissionEnabled } from '../domain/workflow-config.js';
import {
  emptyCreateLists,
  indexFromStatus,
  type AllowedNewSymbol,
  type ModificationContract,
} from '../domain/modification-contract.js';
import {
  nameKey,
  normalizePath,
  type AdmissionAuditResult,
  type AdmissionAuditViolation,
  type AdmissionRequest,
  type AdmissionRequestType,
} from '../domain/admission.js';
import type { ReuseAnalysis } from '../domain/plan.js';
import { AdmissionError } from '../domain/errors.js';
import { isTerminal } from '../domain/transitions.js';
import {
  HeuristicAdmissionReviewer,
  pickReviewerKind,
  type IAdmissionReviewer,
} from './admission-reviewer.js';
import type { ImpactRisk } from '../domain/code-intelligence.js';

const execFileAsync = promisify(execFile);

export interface SubmitAdmissionInput {
  task_id: string;
  type: AdmissionRequestType;
  proposed: AdmissionRequest['proposed'];
  need?: string;
  gitnexus_searches?: string[];
  existing_candidates?: AdmissionRequest['existing_candidates'];
  why_existing_file_is_not_enough?: string;
}

export class CodeAdmissionService {
  constructor(
    private readonly store: AdmissionStore,
    private readonly taskStore: ITaskStore,
    private readonly eventBus: EventBus,
    private readonly workflow: WorkflowConfig | null,
    private readonly projectRoot: string,
    private readonly intelligence?: ICodeIntelligence,
    private readonly workspaceManager?: IWorkspaceManager,
    private readonly reviewer: IAdmissionReviewer = new HeuristicAdmissionReviewer(),
  ) {}

  enabled(): boolean {
    return isAdmissionEnabled(this.workflow);
  }

  workflowConfig(): WorkflowConfig | null {
    return this.workflow;
  }

  async preflight(task: Task): Promise<{ ok: boolean; reasons: string[] }> {
    if (!this.enabled()) return { ok: true, reasons: [] };
    const reasons: string[] = [];
    const contract = await this.ensureFastPathContract(task);
    if (!contract) reasons.push('No modification contract');
    if (this.intelligence && this.workflow?.code_intelligence?.setup?.require_current_index) {
      const status = await this.intelligence.getRepositoryStatus({
        repository_root: this.projectRoot,
        worktree_path: task.workspace,
      });
      if (!status.available || !status.current) {
        reasons.push(status.incomplete_reasons.join('; ') || 'GitNexus index is not current');
      }
    }
    return { ok: reasons.length === 0, reasons };
  }

  async ensureFastPathContract(task: Task): Promise<ModificationContract | null> {
    if (!this.enabled()) return null;
    const existing = await this.store.loadContract(task.id);
    if (existing) return existing;

    const status = this.intelligence
      ? await this.intelligence.getRepositoryStatus({
          repository_root: this.projectRoot,
          worktree_path: task.workspace,
        })
      : {
          provider: 'gitnexus' as const,
          repo: 'unknown',
          available: false,
          current: false,
          incomplete_reasons: ['GitNexus not configured'],
        };

    const now = new Date().toISOString();
    const baseSha = await this.gitHead();
    const contract: ModificationContract = {
      version: 1,
      task_id: task.id,
      goal_id: task.goalId,
      base_sha: baseSha,
      source: task.goalId ? 'planned' : 'fast_path',
      code_index: indexFromStatus(status, now),
      existing_code_considered: [],
      allowed_existing_edits: (task.scope ?? []).map((pattern) => ({
        symbol: '*',
        path: pattern,
        expected_change: 'edit existing files in scope',
      })),
      ...emptyCreateLists(),
      allowed_paths: task.scope,
      notes: task.goalId
        ? ['Planned task — expand the contract via CE reuse analysis or admission requests.']
        : ['Unplanned fast-path contract: no new files, symbols, or dependencies.'],
      status: 'approved',
    };

    await this.store.saveContract(contract);
    this.eventBus.emit({ type: 'code_admission:contract_created', taskId: task.id });
    return contract;
  }

  async getContract(taskId: string): Promise<ModificationContract | null> {
    return this.store.loadContract(taskId);
  }

  async applyReuseCreates(task: Task, reuse: ReuseAnalysis): Promise<ModificationContract | null> {
    const contract = await this.ensureFastPathContract(task);
    if (!contract) return null;
    const now = new Date().toISOString();
    for (const create of reuse.proposed_creates) {
      if (create.kind === 'file' && create.path) {
        if (!contract.allowed_new_files.some((file) => normalizePath(file.path) === normalizePath(create.path ?? ''))) {
          contract.allowed_new_files.push({
            path: create.path,
            reason: create.why_not_reuse,
            why_existing_files_are_not_suitable: create.why_not_reuse,
            approved_by: 'plan',
            approved_at: now,
          });
        }
      }
      if (create.kind === 'symbol' && create.name) {
        if (!contract.allowed_new_symbols.some((symbol) => nameKey(symbol.name) === nameKey(create.name ?? ''))) {
          contract.allowed_new_symbols.push({
            name: create.name,
            kind: 'other',
            path: create.path ?? '(authorized-by-plan)',
            reason: create.why_not_reuse,
            alternatives_considered: reuse.candidates,
            approved_by: 'plan',
            approved_at: now,
          });
        }
      }
      if (create.kind === 'dependency' && create.package) {
        if (!contract.allowed_dependencies.some((dep) => dep.package === create.package)) {
          contract.allowed_dependencies.push({
            package: create.package,
            reason: create.why_not_reuse,
            alternatives_considered: reuse.candidates.map((item) => item.path),
            approved_by: 'plan',
            approved_at: now,
          });
        }
      }
    }
    contract.source = 'planned';
    await this.store.saveContract(contract);
    return contract;
  }

  async releaseTask(taskId: string): Promise<void> {
    await this.store.releaseTask(taskId);
  }

  async submitRequest(input: SubmitAdmissionInput): Promise<AdmissionRequest> {
    if (!this.enabled()) {
      throw new AdmissionError('Code admission is disabled', 'Set code_admission.enabled in .orch/workflow.yml');
    }

    const task = await this.taskStore.get(input.task_id);
    if (!task) throw new AdmissionError(`Task not found: ${input.task_id}`);

    await this.ensureFastPathContract(task);

    const request: AdmissionRequest = {
      id: this.store.createRequestId(),
      task_id: input.task_id,
      type: input.type,
      requested_at: new Date().toISOString(),
      proposed: input.proposed,
      need: input.need,
      gitnexus_searches: input.gitnexus_searches,
      existing_candidates: input.existing_candidates,
      why_existing_file_is_not_enough: input.why_existing_file_is_not_enough,
      status: 'pending',
    };

    const existing = (await this.store.listRequests({ taskId: input.task_id })).find((item) =>
      sameProposed(item, input.type, input.proposed),
    );
    if (existing) return existing;

    await this.store.saveRequest(request);
    this.eventBus.emit({
      type: 'code_admission:request_created',
      taskId: task.id,
      requestId: request.id,
      requestType: request.type,
    });

    return this.decideDeterministic(request, task);
  }

  async listRequests(taskId?: string): Promise<AdmissionRequest[]> {
    return this.store.listRequests(taskId ? { taskId } : undefined);
  }

  async getRequest(id: string): Promise<AdmissionRequest | null> {
    return this.store.getRequest(id);
  }

  async approveRequest(id: string, decidedBy = 'human'): Promise<AdmissionRequest> {
    const request = await this.requireRequest(id);
    const task = await this.taskStore.get(request.task_id);
    if (!task) throw new AdmissionError(`Task not found: ${request.task_id}`);
    const approved = await this.approveAndReserve(request, task, decidedBy);
    await this.applyApprovalToContract(approved);
    return approved;
  }

  async rejectRequest(id: string, reason: string, decidedBy = 'human'): Promise<AdmissionRequest> {
    const request = await this.requireRequest(id);
    return this.finish(request, {
      status: 'rejected',
      decided_at: new Date().toISOString(),
      decided_by: decidedBy,
      reason,
    });
  }

  /**
   * Watcher-owned: resolve pending requests that do not need an LLM.
   */
  async processPending(): Promise<void> {
    if (!this.enabled()) return;
    const queued = [
      ...(await this.store.listRequests({ status: 'pending' })),
      ...(await this.store.listRequests({ status: 'pending_llm' })),
    ];
    for (const request of queued) {
      const task = await this.taskStore.get(request.task_id);
      if (!task || isTerminal(task.status)) {
        await this.store.releaseTask(request.task_id);
        continue;
      }
      if (request.status === 'pending_llm') {
        await this.decideWithReviewer(request, task);
      } else {
        await this.decideDeterministic(request, task);
      }
    }

    const active = await this.taskStore.list();
    const live = new Set(
      active.filter((task) => task.status === 'in_progress' || task.status === 'review').map((task) => task.id),
    );
    await this.store.releaseStale(live);
  }

  async auditTask(task: Task): Promise<AdmissionAuditResult> {
    if (!this.enabled()) {
      return { passed: true, incomplete: false, violations: [], added_files: [], added_symbols: [] };
    }

    const contract = await this.store.loadContract(task.id);
    if (!contract) {
      return {
        passed: false,
        incomplete: true,
        violations: [{ kind: 'incomplete_audit', message: 'No modification contract' }],
        added_files: [],
        added_symbols: [],
      };
    }

    if (this.intelligence && this.workflow?.code_intelligence?.setup?.require_current_index !== false) {
      const status = await this.intelligence.getRepositoryStatus({
        repository_root: this.projectRoot,
        worktree_path: task.workspace,
      });
      if (!status.available || !status.current) {
        return {
          passed: false,
          incomplete: true,
          violations: [{
            kind: 'incomplete_audit',
            message: `GitNexus index is not current: ${status.incomplete_reasons.join('; ') || 'stale'}`,
          }],
          added_files: [],
          added_symbols: [],
        };
      }
    }

    const worktree = task.workspace ?? this.projectRoot;
    const branch = task.proof?.branch;
    const diffs = this.workspaceManager && branch
      ? await this.workspaceManager.getChangedFileDiffs(branch)
      : await this.fallbackNameStatus(contract.base_sha);

    if (task.workspace && worktree !== task.workspace) {
      return {
        passed: false,
        incomplete: true,
        violations: [{ kind: 'wrong_worktree', message: `Worktree mismatch: ${worktree}` }],
        added_files: [],
        added_symbols: [],
      };
    }

    const addedFiles = diffs.filter((diff) => diff.status === 'added').map((diff) => normalizePath(diff.path));
    const approvedFiles = new Set(contract.allowed_new_files.map((file) => normalizePath(file.path)));
    const extraRequests = await this.store.listRequests({ taskId: task.id, status: 'approved' });
    for (const request of extraRequests) {
      if (request.type === 'new_file' && request.proposed.path) {
        approvedFiles.add(normalizePath(request.proposed.path));
      }
    }

    const violations: AdmissionAuditViolation[] = [];
    for (const path of addedFiles) {
      if (!approvedFiles.has(path) && !isTestPath(path, this.workflow)) {
        violations.push({
          kind: 'unapproved_file',
          message: `Unapproved new file: ${path}`,
          path,
        });
      }
    }

    this.auditDependencies(diffs, contract, extraRequests, violations);

    const addedSymbols: string[] = [];
    const audit = this.workflow?.code_admission?.audit;
    if (this.intelligence && audit?.require_gitnexus_detect_changes !== false) {
      const semantic = await this.intelligence.detectChanges({
        worktree,
        base_sha: contract.base_sha,
      });
      if (task.workspace && semantic.worktree && normalizePath(semantic.worktree) !== normalizePath(task.workspace)) {
        return {
          passed: false,
          incomplete: true,
          violations: [{ kind: 'wrong_worktree', message: `GitNexus worktree ${semantic.worktree} ≠ ${task.workspace}` }],
          added_files: addedFiles,
          added_symbols: [],
        };
      }
      if ((semantic.partial && audit?.fail_on_partial !== false) || (semantic.truncated && audit?.fail_on_truncated !== false) || semantic.degraded) {
        violations.push({
          kind: 'incomplete_audit',
          message: 'Admission audit incomplete (GitNexus partial/truncated/degraded)',
        });
        return { passed: false, incomplete: true, violations, added_files: addedFiles, added_symbols: addedSymbols };
      }

      const approvedSymbols = new Set(
        contract.allowed_new_symbols.map((symbol) => nameKey(symbol.name)),
      );
      for (const request of extraRequests) {
        if (request.type === 'new_symbol' && request.proposed.name) {
          approvedSymbols.add(nameKey(request.proposed.name));
        }
      }

      for (const symbol of semantic.added_symbols) {
        addedSymbols.push(symbol.name);
        if (isTestPath(symbol.path ?? '', this.workflow)) continue;
        if (!approvedSymbols.has(nameKey(symbol.name))) {
          violations.push({
            kind: 'unapproved_symbol',
            message: `Unapproved new symbol: ${symbol.name}`,
            name: symbol.name,
            path: symbol.path,
          });
        }
      }

      if (semantic.risk === 'unknown' && addedSymbols.length > 0) {
        violations.push({
          kind: 'incomplete_audit',
          message: 'GitNexus impact risk is UNKNOWN — not treated as LOW',
        });
      }
      if (semantic.risk === 'high' || semantic.risk === 'critical') {
        const approvedHighRisk = extraRequests.some((item) => item.type === 'high_risk_edit');
        if (!approvedHighRisk) {
          violations.push({
            kind: 'unapproved_symbol',
            message: `${semantic.risk.toUpperCase()} impact edit requires an approved high_risk_edit admission`,
          });
        }
      }
    }

    const passed = violations.length === 0;
    this.eventBus.emit({
      type: 'code_admission:audit_completed',
      taskId: task.id,
      passed,
      violations: violations.map((item) => item.message),
    });
    return { passed, incomplete: false, violations, added_files: addedFiles, added_symbols: addedSymbols };
  }

  renderPromptBlock(contract: ModificationContract): string {
    const files = contract.allowed_new_files.map((file) => file.path).join(', ') || 'none';
    const symbols = contract.allowed_new_symbols.map((symbol) => symbol.name).join(', ') || 'none';
    const edits = contract.allowed_existing_edits.map((edit) => `${edit.path} :: ${edit.symbol}`).join(', ') || 'scope only';
    return [
      '## Modification Contract (enforced at merge)',
      `Source: ${contract.source}`,
      `Existing edits: ${edits}`,
      `Approved new files: ${files}`,
      `Approved new symbols: ${symbols}`,
      'New files/exported symbols/dependencies require `orch admission request`.',
      'The watcher decides. Strong GitNexus/ledger hits auto-reject. Do not self-approve.',
    ].join('\n');
  }

  private async decideDeterministic(request: AdmissionRequest, task: Task): Promise<AdmissionRequest> {
    const contract = await this.store.loadContract(task.id);
    if (!contract) return request;

    if (request.type === 'new_file' && request.proposed.path) {
      const reserved = await this.store.findReservation('file', { path: request.proposed.path });
      if (reserved && reserved.task_id !== task.id) {
        return this.redirect(request, reserved.task_id, reserved.path ?? request.proposed.path, undefined, task);
      }
    }

    if (request.type === 'new_symbol' && request.proposed.name) {
      const reserved = await this.store.findReservationByName(request.proposed.name)
        ?? await this.store.findReservation('symbol', request.proposed);
      if (reserved && reserved.task_id !== task.id) {
        return this.redirect(
          request,
          reserved.task_id,
          reserved.path ?? request.proposed.path ?? request.proposed.name ?? '',
          reserved.name,
          task,
        );
      }
    }

    if (request.type === 'new_dependency' && request.proposed.package) {
      const reserved = await this.store.findReservation('dependency', { package: request.proposed.package });
      if (reserved && reserved.task_id !== task.id) {
        return this.redirect(request, reserved.task_id, reserved.package ?? request.proposed.package, undefined, task);
      }
    }

    const hits = await this.collectHits(request, task);
    const strong = hits.find((hit) => isStrongHit(hit, request));
    if (strong) {
      return this.finish(request, {
        status: 'rejected',
        decided_at: new Date().toISOString(),
        decided_by: 'gitnexus',
        reason: `Existing ${strong.path}${strong.symbol ? `#${strong.symbol}` : ''} — reuse it instead of creating.`,
        redirect: { path: strong.path, name: strong.symbol },
      });
    }

    if (request.type === 'new_symbol' && isTestPath(request.proposed.path ?? '', this.workflow)) {
      const approved = await this.approveAndReserve(request, task, 'policy:tests');
      await this.applyApprovalToContract(approved);
      return approved;
    }

    return this.decideWithReviewer(request, task, hits);
  }

  private async decideWithReviewer(
    request: AdmissionRequest,
    task: Task,
    hits?: Array<{ path: string; symbol?: string }>,
  ): Promise<AdmissionRequest> {
    const knownHits = hits ?? await this.collectHits(request, task);
    const impact = await this.lookupImpact(request, task);
    const kind = pickReviewerKind({
      impact,
      councilApprovedPlan: !!task.council_ref,
      type: request.type,
    });
    const decision = await this.reviewer.review({
      request,
      hits: knownHits,
      impact,
      kind,
      councilApprovedPlan: !!task.council_ref,
    });
    if (decision.status === 'approved') {
      const approved = await this.approveAndReserve(request, task, decision.reviewer_model ?? kind);
      approved.decision = {
        ...approved.decision!,
        reason: decision.reason,
        reviewer_model: decision.reviewer_model,
      };
      await this.applyApprovalToContract(approved);
      return this.finish(approved, approved.decision);
    }
    if (decision.status === 'rejected') {
      return this.finish(request, {
        status: 'rejected',
        decided_at: new Date().toISOString(),
        decided_by: kind,
        reason: decision.reason,
        reviewer_model: decision.reviewer_model,
      });
    }
    return this.finish(request, undefined, 'pending_llm');
  }

  private async lookupImpact(request: AdmissionRequest, task: Task): Promise<ImpactRisk | undefined> {
    if (!this.intelligence) return undefined;
    const target = request.proposed.name ?? request.proposed.path ?? request.proposed.package;
    if (!target) return undefined;
    const report = await this.intelligence.getImpact({
      target,
      worktree: task.workspace ?? this.projectRoot,
    });
    return report.risk;
  }

  private async collectHits(request: AdmissionRequest, task: Task): Promise<Array<{ path: string; symbol?: string }>> {
    if (!this.intelligence) return [];
    const queries = [
      ...(request.gitnexus_searches ?? []),
      request.proposed.name,
      request.proposed.path,
    ].filter((item): item is string => !!item);

    const results: Array<{ path: string; symbol?: string }> = [];
    for (const query of queries) {
      const found = await this.intelligence.searchExisting({
        query,
        worktree: task.workspace ?? this.projectRoot,
      });
      for (const item of found) {
        results.push({ path: item.path, symbol: item.symbol });
      }
    }
    return results;
  }

  private async approveAndReserve(request: AdmissionRequest, task: Task, decidedBy: string): Promise<AdmissionRequest> {
    const kind = request.type === 'new_file' ? 'file' : request.type === 'new_dependency' ? 'dependency' : 'symbol';
    await this.store.addReservation({
      kind,
      path: request.proposed.path,
      name: request.proposed.name,
      package: request.proposed.package,
      task_id: task.id,
      request_id: request.id,
    });
    return this.finish(request, {
      status: 'approved',
      decided_at: new Date().toISOString(),
      decided_by: decidedBy,
      reason: 'Deterministic policy approved this create.',
    });
  }

  private async redirect(
    request: AdmissionRequest,
    ownerTaskId: string,
    path: string,
    name: string | undefined,
    task: Task,
  ): Promise<AdmissionRequest> {
    if (ownerTaskId !== task.id && !task.depends_on.includes(ownerTaskId)) {
      task.depends_on = [...task.depends_on, ownerTaskId];
      task.updated_at = new Date().toISOString();
      await this.taskStore.save(task);
    }
    return this.finish(request, {
      status: 'redirected',
      decided_at: new Date().toISOString(),
      decided_by: 'ledger',
      reason: `Already reserved by ${ownerTaskId}. Edit that surface after it merges.`,
      redirect: { path, name, reserved_by_task: ownerTaskId },
    });
  }

  private async finish(
    request: AdmissionRequest,
    decision?: AdmissionRequest['decision'],
    status?: AdmissionRequest['status'],
  ): Promise<AdmissionRequest> {
    const next: AdmissionRequest = {
      ...request,
      status: status ?? decision?.status ?? request.status,
      decision,
    };
    await this.store.saveRequest(next);
    if (decision) {
      this.eventBus.emit({
        type: 'code_admission:request_decided',
        taskId: next.task_id,
        requestId: next.id,
        approved: decision.status === 'approved',
      });
    }
    return next;
  }

  private async applyApprovalToContract(request: AdmissionRequest): Promise<void> {
    const contract = await this.store.loadContract(request.task_id);
    if (!contract) return;
    const now = new Date().toISOString();
    if (request.type === 'new_file' && request.proposed.path) {
      if (!contract.allowed_new_files.some((file) => normalizePath(file.path) === normalizePath(request.proposed.path ?? ''))) {
        contract.allowed_new_files.push({
          path: request.proposed.path,
          reason: request.need ?? request.decision?.reason ?? 'Admission approved',
          why_existing_files_are_not_suitable: request.why_existing_file_is_not_enough ?? 'Approved create',
          approved_by: request.decision?.decided_by ?? 'admission',
          approved_at: now,
        });
      }
    }
    if (request.type === 'new_symbol' && request.proposed.name) {
      if (!contract.allowed_new_symbols.some((symbol) => nameKey(symbol.name) === nameKey(request.proposed.name ?? ''))) {
        contract.allowed_new_symbols.push({
          name: request.proposed.name,
          kind: (request.proposed.kind as AllowedNewSymbol['kind']) ?? 'other',
          path: request.proposed.path ?? '(authorized-by-admission)',
          reason: request.need ?? request.decision?.reason ?? 'Admission approved',
          alternatives_considered: (request.existing_candidates ?? []).map((item) => ({
            path: item.path,
            symbol: item.symbol,
            relevance: 'low' as const,
            decision: 'not_suitable' as const,
            reason: item.why_not_reuse ?? 'Considered during admission',
          })),
          approved_by: request.decision?.decided_by ?? 'admission',
          approved_at: now,
        });
      }
    }
    if (request.type === 'new_dependency' && request.proposed.package) {
      if (!contract.allowed_dependencies.some((dep) => dep.package === request.proposed.package)) {
        contract.allowed_dependencies.push({
          package: request.proposed.package,
          reason: request.need ?? request.decision?.reason ?? 'Admission approved',
          alternatives_considered: (request.existing_candidates ?? []).map((item) => item.path),
          approved_by: request.decision?.decided_by ?? 'admission',
          approved_at: now,
        });
      }
    }
    await this.store.saveContract(contract);
  }

  private auditDependencies(
    diffs: ChangedFileDiff[],
    contract: ModificationContract,
    extraRequests: AdmissionRequest[],
    violations: AdmissionAuditViolation[],
  ): void {
    const approved = new Set(contract.allowed_dependencies.map((dep) => dep.package.toLowerCase()));
    for (const request of extraRequests) {
      if (request.type === 'new_dependency' && request.proposed.package) {
        approved.add(request.proposed.package.toLowerCase());
      }
    }
    for (const diff of diffs) {
      if (!normalizePath(diff.path).endsWith('package.json')) continue;
      for (const line of diff.addedLines) {
        const match = line.match(/^\s*"([^"]+)"\s*:\s*"/);
        if (!match?.[1]) continue;
        const pkg = match[1];
        if (pkg.startsWith('@types/') || pkg === 'name' || pkg === 'version' || pkg === 'description') continue;
        if (!approved.has(pkg.toLowerCase())) {
          violations.push({
            kind: 'unapproved_dependency',
            message: `Unapproved new dependency: ${pkg}`,
            name: pkg,
            path: diff.path,
          });
        }
      }
    }
  }

  private async requireRequest(id: string): Promise<AdmissionRequest> {
    const request = await this.store.getRequest(id);
    if (!request) throw new AdmissionError(`Admission request not found: ${id}`);
    return request;
  }

  private async gitHead(): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: this.projectRoot });
      return stdout.trim();
    } catch {
      return 'unknown';
    }
  }

  private async fallbackNameStatus(baseSha: string): Promise<ChangedFileDiff[]> {
    if (!baseSha || baseSha === 'unknown') return [];
    try {
      const { stdout } = await execFileAsync('git', ['diff', '--name-status', baseSha], { cwd: this.projectRoot });
      return stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [code, ...rest] = line.split(/\s+/);
          const path = rest[rest.length - 1] ?? '';
          const status = code === 'A' ? 'added' : code === 'D' ? 'deleted' : code === 'R' ? 'renamed' : 'modified';
          return { path, status, addedLines: [] };
        });
    } catch {
      return [];
    }
  }
}

function isStrongHit(hit: { path: string; symbol?: string }, request: AdmissionRequest): boolean {
  const path = normalizePath(request.proposed.path ?? '');
  if (path && normalizePath(hit.path) === path) return true;
  const name = request.proposed.name;
  if (name && hit.symbol && nameKey(hit.symbol) === nameKey(name)) return true;
  return false;
}

function sameProposed(
  request: AdmissionRequest,
  type: AdmissionRequestType,
  proposed: AdmissionRequest['proposed'],
): boolean {
  if (request.type !== type) return false;
  return (
    (proposed.path ?? '') === (request.proposed.path ?? '') &&
    (proposed.name ?? '') === (request.proposed.name ?? '') &&
    (proposed.package ?? '') === (request.proposed.package ?? '')
  );
}

function isTestPath(path: string, workflow: WorkflowConfig | null): boolean {
  if (workflow?.code_admission?.new_symbols?.tests !== 'allow') return false;
  const normalized = normalizePath(path).toLowerCase();
  return (
    normalized.includes('/test/') ||
    normalized.includes('/tests/') ||
    normalized.includes('.test.') ||
    normalized.includes('.spec.')
  );
}
