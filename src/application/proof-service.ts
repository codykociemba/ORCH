/**
 * Aggregate verification + admission evidence and render proof bodies.
 */

import type { Task } from '../domain/task.js';
import type { VerificationEvidence } from '../domain/evidence.js';
import type { AdmissionAuditResult } from '../domain/admission.js';
import type { ModificationContract } from '../domain/modification-contract.js';
import { renderGitHubProof, renderLinearProof } from '../infrastructure/proof/renderers.js';
import { reviewAllowsMerge, type ReviewPolicy } from './review-policy.js';

export class ProofService {
  build(input: {
    task: Task;
    audit?: AdmissionAuditResult;
    contract?: Pick<
      ModificationContract,
      | 'existing_code_considered'
      | 'allowed_existing_edits'
      | 'allowed_new_files'
      | 'allowed_new_symbols'
      | 'allowed_dependencies'
      | 'code_index'
    >;
    learningRefs?: string[];
    reviewPolicy?: ReviewPolicy;
    headSha?: string;
    checks?: VerificationEvidence['checks'];
    reviews?: VerificationEvidence['reviews'];
    wiki?: VerificationEvidence['wiki'];
    conventionFiles?: ConventionDiff[];
    conventionRules?: ConventionRules;
  }): VerificationEvidence {
    const considered = input.contract?.existing_code_considered ?? [];
    const edits = input.contract?.allowed_existing_edits ?? [];
    const reused = considered
      .filter((item) => item.decision === 'reuse' || item.decision === 'modify')
      .map((item) => item.symbol ?? item.path);
    const modified = edits.map((item) => item.symbol);
    const rank: Record<string, number> = { low: 1, medium: 2, unknown: 3, high: 4, critical: 5 };
    let impactRisk: string | undefined;
    let best = 0;
    for (const risk of edits.map((item) => item.impact?.risk).filter((item): item is string => Boolean(item))) {
      const score = rank[risk] ?? 0;
      if (score > best) {
        best = score;
        impactRisk = risk;
      }
    }
    const admission = input.audit
      ? {
          passed: input.audit.passed,
          incomplete: input.audit.incomplete,
          violations: input.audit.violations.map((item) => item.message),
          existing_candidates: considered.length,
          reused_symbols: reused,
          modified_existing_symbols: modified,
          approved_new_files: (input.contract?.allowed_new_files ?? []).map((item) => item.path),
          actual_new_files: input.audit.added_files,
          approved_new_symbols: (input.contract?.allowed_new_symbols ?? []).map((item) => item.name),
          actual_new_symbols: input.audit.added_symbols,
          approved_dependencies: (input.contract?.allowed_dependencies ?? []).map((item) => item.package),
          affected_processes: input.audit.processes ?? [],
          impact_risk: impactRisk,
          index_current: input.contract?.code_index?.index_current,
          index_commit: input.contract?.code_index?.index_commit,
        } as NonNullable<VerificationEvidence['admission']>
      : undefined;

    const checks = [...(input.checks ?? (input.task.review_results ?? []).map((result) => ({
      name: result.criterion,
      status: result.passed ? 'passed' as const : 'failed' as const,
      summary: result.output.slice(0, 300),
      exit_code: result.passed ? 0 : 1,
    })))];
    const convention = evaluateConventions(input.conventionFiles, input.conventionRules);
    if (convention) checks.push(convention);
    const reviews = input.reviews ?? input.task.reviews ?? [];
    const admissionOk = !admission || (admission.passed && !admission.incomplete);
    const checksOk = checks.every((check) => check.status !== 'failed');
    const shaOk = !!input.headSha;
    const reviewsOk = reviewAllowsMerge(
      reviews,
      input.reviewPolicy ?? 'human_or_cursor',
      input.headSha,
    );
    const indexOk = input.contract?.code_index?.index_current !== false
      && input.wiki?.index_current !== false
      && input.wiki?.status !== 'failed';
    const verified = admissionOk && checksOk && shaOk && reviewsOk && indexOk;

    return {
      task_id: input.task.id,
      plan_id: input.task.plan_id,
      plan_unit_id: input.task.plan_unit_id,
      branch: input.task.proof?.branch,
      pr_url: input.task.external?.github?.pr_url ?? input.task.proof?.pr_url,
      head_sha: input.headSha,
      files_changed: input.task.proof?.files_changed?.length
        ? input.task.proof.files_changed
        : (input.audit?.added_files ?? []),
      checks,
      reviews,
      acceptance_criteria: (input.task.acceptance_criteria ?? []).map((description) => ({
        description,
        passed: checksOk && admissionOk,
      })),
      agent_summary: input.task.proof?.agent_summary,
      council_ref: input.task.council_ref,
      learning_refs: input.learningRefs,
      admission,
      wiki: input.wiki,
      verified,
      verified_at: verified ? new Date().toISOString() : undefined,
    };
  }

  renderGitHub(
    evidence: VerificationEvidence,
    extras?: { linear?: string; linearUrl?: string },
  ): string {
    return renderGitHubProof(evidence, extras);
  }

  renderLinear(evidence: VerificationEvidence): string {
    return renderLinearProof(evidence);
  }
}

/** Spec §3.4 — loaded from workflow.conventions extra keys; missing rules skip the gate. */
interface ConventionRules {
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
}

interface ConventionDiff {
  path: string;
  status: 'added' | 'modified';
  content?: string;
  addedLines?: string[];
}

const DEFAULT_FORBIDDEN = ['**/utils/**', '**/helpers/**', '**/lib/misc/**'];
const DEFAULT_ROOTS = ['src/', 'test/', 'docs/'];
const DEFAULT_ALLOWED_COMMENTS = [
  '^\\s*//\\s*eslint-disable',
  '^\\s*//\\s*@ts-expect-error',
  '^\\s*//\\s*@ts-ignore',
  '^\\s*/\\*\\s*c8 ignore',
];
const DEFAULT_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

function evaluateConventions(
  files: ConventionDiff[] | undefined,
  rules: ConventionRules | undefined,
): VerificationEvidence['checks'][number] | undefined {
  if (rules?.enabled === false) return undefined;
  if (!files || files.length === 0) {
    return rules?.enabled === true
      ? { name: 'conventions', status: 'skipped', summary: 'no attributed files to lint' }
      : undefined;
  }
  if (rules?.enabled !== true && !rules?.organization && !rules?.comments) return undefined;

  const org = rules.organization ?? {};
  const comments = rules.comments ?? {};
  const forbidden = org.forbidden_new_file_globs ?? DEFAULT_FORBIDDEN;
  const roots = org.allowed_new_file_roots ?? DEFAULT_ROOTS;
  const maxNew = org.max_new_files_per_task ?? 8;
  const extensions = comments.extensions ?? DEFAULT_EXTENSIONS;
  const allowed = (comments.allowed_inline_patterns ?? DEFAULT_ALLOWED_COMMENTS).map((item) => new RegExp(item));
  const headerMax = comments.header_max_lines ?? 4;
  const headerMin = comments.header_min_lines ?? 1;
  const violations: string[] = [];

  const added = files.filter((file) => file.status === 'added');
  if (added.length > maxNew) {
    violations.push(`max_new_files_per_task ${maxNew} exceeded (${added.length}) — split the task or edit existing modules`);
  }
  for (const file of added) {
    const normalized = file.path.replace(/\\/g, '/');
    if (org.no_parallel_utils !== false && forbidden.some((glob) => matchSimpleGlob(normalized, glob))) {
      violations.push(`no_parallel_utils: new file ${normalized} matches ${forbidden.join(', ')}`);
    }
    if (roots.length > 0 && !roots.some((root) => normalized.startsWith(root.replace(/\\/g, '/')))) {
      violations.push(`new file ${normalized} is outside allowed roots ${roots.join(', ')}`);
    }
  }

  for (const file of files) {
    const ext = extensionOf(file.path);
    if (!extensions.includes(ext)) continue;
    if (file.status === 'added' && file.content !== undefined) {
      violations.push(...lintNewFileComments(file.path, file.content, { headerMax, headerMin, allowed }));
    } else if (file.status === 'modified') {
      violations.push(...lintAddedCommentLines(file.path, file.addedLines ?? [], allowed));
    }
  }

  const summary = `${added.length} new files, ${violations.length} convention violation(s)`;
  return {
    name: 'conventions',
    status: violations.length === 0 ? 'passed' : 'failed',
    summary: violations.length === 0 ? summary : `${summary}: ${violations.slice(0, 3).join('; ')}`,
    exit_code: violations.length === 0 ? 0 : 1,
  };
}

function matchSimpleGlob(filePath: string, glob: string): boolean {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`).test(filePath) || new RegExp(escaped).test(filePath);
}

function extensionOf(filePath: string): string {
  const base = filePath.replace(/\\/g, '/');
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot) : '';
}

function lintNewFileComments(
  filePath: string,
  content: string,
  opts: { headerMax: number; headerMin: number; allowed: RegExp[] },
): string[] {
  const comments = collectComments(content);
  if (comments.length === 0) {
    return [`${filePath}: new file is missing a 1–${opts.headerMax} line file header`];
  }
  const header = comments[0]!;
  if (header.startIndex > leadingIgnorableLength(content)) {
    return [`${filePath}: file header must be the first comment`];
  }
  const headerLines = header.text.split('\n').map((line) => line.trim()).filter(Boolean);
  if (headerLines.length < opts.headerMin || headerLines.length > opts.headerMax) {
    return [`${filePath}: file header must be ${opts.headerMin}–${opts.headerMax} non-empty lines (got ${headerLines.length})`];
  }
  const violations: string[] = [];
  for (const comment of comments.slice(1)) {
    if (opts.allowed.some((pattern) => pattern.test(comment.raw))) continue;
    violations.push(`${filePath}: inline comment / JSDoc is not allowed after the file header`);
  }
  return violations;
}

function lintAddedCommentLines(filePath: string, addedLines: string[], allowed: RegExp[]): string[] {
  const violations: string[] = [];
  for (const line of addedLines) {
    if (!looksLikeCommentLine(line)) continue;
    if (allowed.some((pattern) => pattern.test(line))) continue;
    violations.push(`${filePath}: added inline comment is not allowed`);
  }
  return violations;
}

function looksLikeCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*');
}

function leadingIgnorableLength(content: string): number {
  let rest = content;
  let consumed = 0;
  if (rest.startsWith('#!')) {
    const end = rest.indexOf('\n');
    const skip = end === -1 ? rest.length : end + 1;
    consumed += skip;
    rest = rest.slice(skip);
  }
  const strict = rest.match(/^\s*['"]use strict['"];?\s*\n?/);
  if (strict) consumed += strict[0].length;
  return consumed;
}

function collectComments(source: string): Array<{ text: string; raw: string; startIndex: number }> {
  const comments: Array<{ text: string; raw: string; startIndex: number }> = [];
  let i = 0;
  let quote: '"' | "'" | '`' | null = null;
  let escaped = false;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\' && quote !== '`') escaped = true;
      else if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      const start = i;
      const end = source.indexOf('\n', i);
      const raw = source.slice(start, end === -1 ? source.length : end);
      comments.push({ text: raw.replace(/^\/\/\s?/, ''), raw, startIndex: start });
      i = end === -1 ? source.length : end;
      continue;
    }
    if (ch === '/' && next === '*') {
      const start = i;
      const end = source.indexOf('*/', i + 2);
      const raw = source.slice(start, end === -1 ? source.length : end + 2);
      comments.push({ text: raw.replace(/^\/\*+/, '').replace(/\*+\/$/, '').trim(), raw, startIndex: start });
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    i += 1;
  }
  return comments;
}
