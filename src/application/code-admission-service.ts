/**
 * Code admission — watcher-owned policy over GitNexus + the global ledger.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
import type { ImpactRisk, RepositoryIdentityInput } from '../domain/code-intelligence.js';

const execFileAsync = promisify(execFile);

/** Last task identity seen by preflight — dispatch calls renderPromptBlock without the worktree. */
const workerContextByTask = new Map<string, { worktree: string; branch?: string; head_sha?: string }>();
/** Shared-mode dirty note keyed by contract base SHA — consumed by auditDependencies. */
const sharedDirtyNote = new Map<string, string>();

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
    workerContextByTask.set(task.id, {
      worktree: task.workspace ?? this.projectRoot,
      branch: task.proof?.branch,
      head_sha: task.proof?.head_sha,
    });
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
   * Watcher-owned: resolve pending and pending_llm requests.
   * pending_llm retries re-run deterministic PDG / strong-hit checks first.
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
      await this.decideDeterministic(request, task);
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

    if (contract.status === 'superseded') {
      return {
        passed: false,
        incomplete: false,
        violations: [{ kind: 'incomplete_audit', message: 'Superseded contract cannot authorize current work' }],
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

    const addedFiles = diffs
      .filter((diff) => diff.status === 'added')
      .map((diff) => normalizePath(diff.path));
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
      const semanticEmpty = semantic.added_symbols.length === 0
        && semantic.modified_symbols.length === 0
        && semantic.deleted_symbols.length === 0;
      if (semanticEmpty && diffs.length > 0 && !(await this.confirmWorktree(worktree, task.workspace))) {
        violations.push({
          kind: 'wrong_worktree',
          message: `Empty GitNexus change set is not success until git worktree, worker workspace, and task workspace agree (${worktree})`,
        });
        return { passed: false, incomplete: true, violations, added_files: addedFiles, added_symbols: [] };
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
      if (semantic.risk === 'medium' && this.workflow?.code_admission?.impact?.medium !== 'require_approval') {
        const touched = semantic.added_symbols.length + semantic.modified_symbols.length;
        const hasDependentTests = diffs.some((diff) => isTestPath(diff.path, this.workflow));
        if (touched > 0 && !hasDependentTests) {
          violations.push({
            kind: 'incomplete_audit',
            message: 'MEDIUM impact requires tests for dependents',
          });
        }
      }
      if (semantic.risk === 'critical') {
        const independent = (task.reviews ?? []).some((review) => (
          review.verdict === 'approve'
          && (review.reviewer_type === 'cursor' || review.reviewer_type === 'codex' || review.reviewer_type === 'claude')
        ));
        if (!independent) {
          violations.push({
            kind: 'unapproved_symbol',
            message: 'CRITICAL impact requires independent review (cursor, Codex, or Claude)',
          });
        }
      }

      const deletedSymbols = semantic.deleted_symbols.map((symbol) => symbol.name);
      const processes = [...semantic.processes];
      if (processes.length > 0 && (semantic.risk === 'high' || semantic.risk === 'critical')) {
        const last = violations[violations.length - 1];
        if (last && (last.kind === 'unapproved_symbol' || last.kind === 'incomplete_audit')) {
          last.message = `${last.message} (processes: ${processes.join(', ')})`;
        }
      }

      const passed = violations.length === 0;
      this.eventBus.emit({
        type: 'code_admission:audit_completed',
        taskId: task.id,
        passed,
        violations: violations.map((item) => item.message),
      });
      return {
        passed,
        incomplete: false,
        violations,
        added_files: addedFiles,
        added_symbols: addedSymbols,
        deleted_symbols: deletedSymbols,
        processes,
      };
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

  renderPromptBlock(
    contract: ModificationContract,
    workspacePath?: string,
    identity?: { branch?: string; head_sha?: string },
  ): string {
    const files = contract.allowed_new_files.map((file) => file.path).join(', ') || 'none';
    const symbols = contract.allowed_new_symbols.map((symbol) => symbol.name).join(', ') || 'none';
    const edits = contract.allowed_existing_edits.map((edit) => `${edit.path} :: ${edit.symbol}`).join(', ') || 'scope only';
    const cached = workerContextByTask.get(contract.task_id);
    const worktree = workspacePath ?? cached?.worktree ?? this.projectRoot;
    const branch = identity?.branch ?? cached?.branch ?? 'unknown';
    const headSha = identity?.head_sha ?? cached?.head_sha ?? contract.base_sha;
    return [
      '## Modification Contract (enforced at merge)',
      `Source: ${contract.source}`,
      `Existing edits: ${edits}`,
      `Approved new files: ${files}`,
      `Approved new symbols: ${symbols}`,
      '## Worker code context',
      `repository_root: ${this.projectRoot}`,
      `worktree_path: ${worktree}`,
      `branch: ${branch}`,
      `base_sha: ${contract.base_sha}`,
      `head_sha: ${headSha}`,
      `gitnexus.repo: ${contract.code_index.repo}`,
      `gitnexus.worktree: ${worktree}`,
      `gitnexus.index_commit: ${contract.code_index.index_commit || 'unknown'}`,
      `gitnexus.index_current: ${contract.code_index.index_current ? 'yes' : 'no'}`,
      'Pass this worktree to every GitNexus detect_changes call. A zero from the wrong checkout is not success.',
      'New files/exported symbols/dependencies require `orch admission request new-file|new-symbol|dependency`.',
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

    const hay = [
      request.type,
      request.need,
      request.proposed.name,
      request.proposed.path,
      request.proposed.package,
      request.why_existing_file_is_not_enough,
      ...(request.gitnexus_searches ?? []),
    ].filter(Boolean).join(' ');
    const sensitive = request.type === 'high_risk_edit'
      || /\b(security|auth|payments?|concurrency|dataflow(?:-sensitive)?)\b/i.test(hay);
    if (sensitive && this.intelligence) {
      const run = this.intelligence.analyze;
      if (typeof run !== 'function') {
        return this.finish(request, {
          status: 'rejected',
          decided_at: new Date().toISOString(),
          decided_by: 'gitnexus',
          reason: 'PDG required for security/auth/payments/concurrency/dataflow-sensitive admission',
        });
      }
      try {
        await run({
          repository_root: this.projectRoot,
          worktree_path: task.workspace ?? this.projectRoot,
          pdg: true,
        } as RepositoryIdentityInput);
      } catch {
        return this.finish(request, {
          status: 'rejected',
          decided_at: new Date().toISOString(),
          decided_by: 'gitnexus',
          reason: 'PDG required for security/auth/payments/concurrency/dataflow-sensitive admission — gitnexus analyze --pdg failed',
        });
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
    const worktree = task.workspace ?? this.projectRoot;
    const results: Array<{ path: string; symbol?: string }> = [];

    if (request.proposed.name) {
      try {
        const context = await this.intelligence.getSymbolContext({
          symbol: request.proposed.name,
          path: request.proposed.path,
          worktree,
        });
        if (context.path) {
          results.push({ path: context.path, symbol: context.symbol || request.proposed.name });
        }
      } catch {
        // A missing/failed exact lookup is not a hit.
      }
    }

    const queries = [
      ...(request.gitnexus_searches ?? []),
      request.proposed.name,
      request.proposed.path,
    ].filter((item): item is string => !!item);

    for (const query of queries) {
      const found = await this.intelligence.searchExisting({
        query,
        worktree,
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
    const dirtyMsg = sharedDirtyNote.get(contract.base_sha);
    if (dirtyMsg) {
      violations.push({ kind: 'incomplete_audit', message: dirtyMsg });
      sharedDirtyNote.delete(contract.base_sha);
    }
    auditConventionDiffs(this.workflow, diffs, violations);
    if ((this.workflow as { conventions?: { enabled?: boolean } } | null)?.conventions?.enabled === true) {
      for (const diff of diffs) {
        if (diff.status === 'deleted' || diff.status === 'renamed') continue;
        for (const line of diff.addedLines) {
          if (!/@(param|returns?|example|typedef|template|throws|deprecated|see)\b/.test(line)) continue;
          violations.push({
            kind: 'unapproved_file',
            message: `conventions: ${diff.path} added function JSDoc`,
            path: diff.path,
          });
          break;
        }
      }
    }
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

  /** Spec addendum §11.3: a wrong-worktree zero is not success. */
  private async confirmWorktree(worktree: string, taskWorkspace?: string): Promise<boolean> {
    if (taskWorkspace && normalizePath(worktree) !== normalizePath(taskWorkspace)) return false;
    if (!taskWorkspace && normalizePath(worktree) === normalizePath(this.projectRoot)) return true;
    try {
      const { stdout: toplevel } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: worktree });
      const root = toplevel.trim();
      if (!root) return false;
      const { stdout: listed } = await execFileAsync('git', ['worktree', 'list', '--porcelain'], { cwd: this.projectRoot });
      const worktrees = listed
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => normalizePath(line.slice('worktree '.length).trim()));
      const expected = new Set([normalizePath(worktree), normalizePath(root)]);
      return worktrees.some((entry) => expected.has(entry));
    } catch {
      return false;
    }
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
      const rows = stdout.trim().split('\n').filter(Boolean);
      const diffs: ChangedFileDiff[] = [];
      for (const line of rows) {
        const [code, ...rest] = line.split(/\s+/);
        const filePath = rest[rest.length - 1] ?? '';
        const status = code === 'A' ? 'added' : code === 'D' ? 'deleted' : code === 'R' ? 'renamed' : 'modified';
        let addedLines: string[] = [];
        if (status !== 'deleted' && filePath) {
          try {
            const { stdout: patch } = await execFileAsync(
              'git',
              ['diff', '-U0', baseSha, '--', filePath],
              { cwd: this.projectRoot },
            );
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
      try {
        const { stdout: porcelain } = await execFileAsync('git', ['status', '--porcelain', '-uall'], {
          cwd: this.projectRoot,
        });
        const seen = new Set(diffs.map((diff) => normalizePath(diff.path)));
        for (const row of porcelain.split('\n')) {
          if (!row.startsWith('??')) continue;
          const untracked = row.slice(3).trim().replace(/^"|"$/g, '').split(' -> ').pop() ?? '';
          if (!untracked || seen.has(normalizePath(untracked))) continue;
          seen.add(normalizePath(untracked));
          let lines: string[] = [];
          try {
            lines = (await readFile(join(this.projectRoot, untracked), 'utf8')).split('\n');
          } catch {
            lines = [];
          }
          diffs.push({ path: untracked, status: 'added', addedLines: lines });
        }
      } catch {
        // Untracked files stay invisible if porcelain fails; name-status diffs still audit.
      }
      sharedDirtyNote.delete(baseSha);
      try {
        const live = (await this.taskStore.list()).filter((task) => !isTerminal(task.status));
        const shared: Task[] = [];
        for (const task of live) {
          const owned = await this.store.loadContract(task.id);
          if (!owned || owned.base_sha !== baseSha) continue;
          const isShared = task.workspace_mode === 'shared' || (!task.workspace && !task.proof?.branch);
          if (isShared) shared.push(task);
        }
        if (shared.length > 1 && diffs.length > 0) {
          sharedDirtyNote.set(baseSha, 'shared workspace is dirty; cannot attribute convention violations');
        } else if (shared.length === 1) {
          const attributed = new Set((shared[0]!.proof?.files_changed ?? []).map((file) => normalizePath(file)));
          const dirty = diffs.map((diff) => normalizePath(diff.path)).filter(Boolean);
          if (dirty.length > 0 && (attributed.size === 0 || dirty.some((file) => !attributed.has(file)))) {
            sharedDirtyNote.set(baseSha, 'shared workspace is dirty; cannot attribute convention violations');
          }
        }
      } catch {
        // Attribution is best-effort; git diffs still audit.
      }
      return diffs;
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

/** Spec §3.4: conventions fail the admission audit (and therefore merge-back) when enabled. */
function auditConventionDiffs(
  workflow: WorkflowConfig | null,
  diffs: ChangedFileDiff[],
  violations: AdmissionAuditViolation[],
): void {
  const rules = (workflow as { conventions?: {
    enabled?: boolean;
    organization?: {
      no_parallel_utils?: boolean;
      allowed_new_file_roots?: string[];
      forbidden_new_file_globs?: string[];
      max_new_files_per_task?: number;
    };
    comments?: {
      header_max_lines?: number;
      header_min_lines?: number;
      allowed_inline_patterns?: string[];
      extensions?: string[];
    };
  } } | null)?.conventions;
  if (rules?.enabled !== true) return;

  const forbidden = rules.organization?.forbidden_new_file_globs ?? ['**/utils/**', '**/helpers/**', '**/lib/misc/**'];
  const roots = rules.organization?.allowed_new_file_roots ?? ['src/', 'test/', 'docs/'];
  const maxNew = rules.organization?.max_new_files_per_task ?? 8;
  const extensions = rules.comments?.extensions ?? ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
  const allowed = (rules.comments?.allowed_inline_patterns ?? [
    '^\\s*//\\s*eslint-disable',
    '^\\s*//\\s*@ts-expect-error',
    '^\\s*//\\s*@ts-ignore',
    '^\\s*/\\*\\s*c8 ignore',
  ]).map((item) => new RegExp(item));
  const headerMax = rules.comments?.header_max_lines ?? 4;
  const headerMin = rules.comments?.header_min_lines ?? 1;
  const added = diffs.filter((diff) => diff.status === 'added');
  if (added.length > maxNew) {
    violations.push({
      kind: 'unapproved_file',
      message: `conventions: max_new_files_per_task ${maxNew} exceeded (${added.length})`,
    });
  }
  for (const diff of added) {
    const filePath = normalizePath(diff.path);
    if (rules.organization?.no_parallel_utils !== false && forbidden.some((glob) => matchConventionGlob(filePath, glob))) {
      violations.push({
        kind: 'unapproved_file',
        message: `conventions: no_parallel_utils forbids new file ${filePath}`,
        path: filePath,
      });
    }
    if (roots.length > 0 && !roots.some((root) => filePath.startsWith(root.replace(/\\/g, '/')))) {
      violations.push({
        kind: 'unapproved_file',
        message: `conventions: ${filePath} is outside allowed roots ${roots.join(', ')}`,
        path: filePath,
      });
    }
  }
  for (const diff of diffs) {
    const filePath = normalizePath(diff.path);
    const ext = filePath.slice(filePath.lastIndexOf('.'));
    if (!extensions.includes(ext) || diff.status === 'deleted' || diff.status === 'renamed') continue;
    if (diff.status === 'added') {
      const content = diff.addedLines.join('\n');
      const comments = collectSourceComments(content);
      if (comments.length === 0) {
        violations.push({
          kind: 'unapproved_file',
          message: `conventions: ${filePath} is missing a 1–${headerMax} line file header`,
          path: filePath,
        });
        continue;
      }
      const headerLines = comments[0]!.text.split('\n').map((line) => line.trim()).filter(Boolean);
      if (headerLines.length < headerMin || headerLines.length > headerMax) {
        violations.push({
          kind: 'unapproved_file',
          message: `conventions: ${filePath} header must be ${headerMin}–${headerMax} lines`,
          path: filePath,
        });
      }
      for (const comment of comments.slice(1)) {
        if (allowed.some((pattern) => pattern.test(comment.raw))) continue;
        violations.push({
          kind: 'unapproved_file',
          message: `conventions: ${filePath} has an inline comment after the file header`,
          path: filePath,
        });
        break;
      }
    } else {
      for (const line of diff.addedLines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('//') && !trimmed.startsWith('/*') && !trimmed.startsWith('*')) continue;
        if (allowed.some((pattern) => pattern.test(line))) continue;
        violations.push({
          kind: 'unapproved_file',
          message: `conventions: ${filePath} added an inline comment`,
          path: filePath,
        });
        break;
      }
    }
  }
}

function matchConventionGlob(filePath: string, glob: string): boolean {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
  return new RegExp(escaped).test(filePath);
}

function collectSourceComments(source: string): Array<{ text: string; raw: string }> {
  const comments: Array<{ text: string; raw: string }> = [];
  let i = 0;
  if (source.startsWith('#!')) {
    const nl = source.indexOf('\n');
    i = nl === -1 ? source.length : nl + 1;
  }
  while (i < source.length && (source[i] === ' ' || source[i] === '\t' || source[i] === '\n' || source[i] === '\r')) i += 1;
  if (source.startsWith("'use strict'", i) || source.startsWith('"use strict"', i)) {
    i += 12;
    if (source[i] === ';') i += 1;
  }
  let quote: '"' | "'" | null = null;
  let inTemplate = false;
  let escaped = false;
  let interp = 0;
  let prev = '';
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (inTemplate && interp === 0 && quote === null) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '$' && next === '{') interp = 1;
      else if (ch === '`') inTemplate = false;
      i += interp === 1 ? 2 : 1;
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (inTemplate && interp > 0) {
      if (ch === '{') {
        interp += 1;
        i += 1;
        continue;
      }
      if (ch === '}') {
        interp -= 1;
        i += 1;
        continue;
      }
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '`') {
      inTemplate = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const raw = source.slice(i, end === -1 ? source.length : end);
      comments.push({ text: raw.replace(/^\/\/\s?/, ''), raw });
      i = end === -1 ? source.length : end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const raw = source.slice(i, end === -1 ? source.length : end + 2);
      comments.push({ text: raw.replace(/^\/\*+/, '').replace(/\*+\/$/, '').trim(), raw });
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === '/' && next !== '/' && next !== '*') {
      const regexStart = !prev
        || '([{,;=!:?&|~^%<>;+\n'.includes(prev)
        || prev === 'return'
        || prev === 'typeof'
        || prev === 'case'
        || prev === 'throw'
        || prev === 'void'
        || prev === 'new'
        || prev === 'delete'
        || prev === 'yield'
        || prev === 'await'
        || prev === 'else'
        || prev === 'in'
        || prev === 'of';
      if (regexStart) {
        i += 1;
        let reEsc = false;
        let inClass = false;
        while (i < source.length) {
          const rch = source[i]!;
          if (reEsc) {
            reEsc = false;
            i += 1;
            continue;
          }
          if (rch === '\\') {
            reEsc = true;
            i += 1;
            continue;
          }
          if (rch === '[' && !inClass) {
            inClass = true;
            i += 1;
            continue;
          }
          if (rch === ']' && inClass) {
            inClass = false;
            i += 1;
            continue;
          }
          if (rch === '/' && !inClass) {
            i += 1;
            break;
          }
          if (rch === '\n') break;
          i += 1;
        }
        while (i < source.length && /[a-z]/i.test(source[i]!)) i += 1;
        prev = '/';
        continue;
      }
    }
    if (!/\s/.test(ch)) {
      if (/[A-Za-z_$]/.test(ch)) {
        let j = i;
        while (j < source.length && /[A-Za-z0-9_$]/.test(source[j]!)) j += 1;
        prev = source.slice(i, j);
        i = j;
        continue;
      }
      prev = ch;
    }
    i += 1;
  }
  return comments;
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
