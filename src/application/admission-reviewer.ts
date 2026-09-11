/**
 * Watcher-owned LLM admission review. Workers never implement this.
 *
 * Decision order after deterministic GitNexus/ledger:
 *   Claude  — fuzzy / architectural
 *   Codex   — high/critical impact or Claude↔graph disagreement
 *   Council — only if it changes a Council-approved 5+ plan
 */

import type { AdmissionRequest } from '../domain/admission.js';
import type { ImpactRisk } from '../domain/code-intelligence.js';
import type { IAgentAdapter } from '../infrastructure/adapters/interface.js';

export type AdmissionReviewerKind = 'claude' | 'codex' | 'council';

export interface AdmissionReviewInput {
  request: AdmissionRequest;
  hits: Array<{ path: string; symbol?: string }>;
  impact?: ImpactRisk;
  kind: AdmissionReviewerKind;
  councilApprovedPlan: boolean;
}

export interface AdmissionReviewDecision {
  status: 'approved' | 'rejected' | 'defer';
  reason: string;
  reviewer_model?: string;
}

export interface IAdmissionReviewer {
  review(input: AdmissionReviewInput): Promise<AdmissionReviewDecision>;
}

/**
 * Fail-closed default: never invent an approval for a new abstraction.
 * Low/medium high_risk_edit may auto-pass (impact policy).
 */
export class HeuristicAdmissionReviewer implements IAdmissionReviewer {
  async review(input: AdmissionReviewInput): Promise<AdmissionReviewDecision> {
    if (input.impact === 'unknown' || (input.request.type === 'high_risk_edit' && input.impact === undefined)) {
      return {
        status: 'rejected',
        reason: 'UNKNOWN impact is not treated as LOW. Resolve callers before creating/editing.',
        reviewer_model: 'policy:unknown',
      };
    }

    if (input.request.type === 'high_risk_edit' && (input.impact === 'high' || input.impact === 'critical')) {
      return {
        status: 'defer',
        reason: 'HIGH/CRITICAL impact requires watcher/Codex approval — not automatic.',
        reviewer_model: 'policy:impact',
      };
    }

    if (input.request.type === 'high_risk_edit' && (input.impact === 'low' || input.impact === 'medium')) {
      return {
        status: 'approved',
        reason: 'Impact policy: low/medium existing-symbol edits are automatic.',
        reviewer_model: 'policy:impact',
      };
    }

    if (input.request.type === 'new_file' || input.request.type === 'new_symbol' || input.request.type === 'new_dependency' || input.request.type === 'scope_expansion') {
      const why = `${input.request.why_existing_file_is_not_enough ?? ''} ${input.request.need ?? ''}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
      if (!why || why === 'cleaner' || why === 'clean' || why === 'nicer') {
        return {
          status: 'rejected',
          reason: input.request.type === 'new_dependency'
            ? 'New dependency needs a problem statement and why stdlib/existing deps are not enough — "cleaner" is not a reason.'
            : input.request.type === 'new_symbol'
              ? 'New symbol needs why the current owner is not enough — "cleaner" is not a reason.'
              : input.request.type === 'scope_expansion'
                ? 'Scope expansion needs why the current contract files/symbols are not enough — "cleaner" is not a reason.'
                : 'New file needs why the current owner is not enough — "cleaner" is not a reason.',
          reviewer_model: 'policy:reuse',
        };
      }
    }

    if (input.councilApprovedPlan && (input.request.type === 'new_file' || input.request.type === 'new_symbol' || input.request.type === 'new_dependency' || input.request.type === 'scope_expansion')) {
      return {
        status: 'defer',
        reason: 'Material create on a Council-approved plan — Council or Codex minimum.',
        reviewer_model: 'policy:council',
      };
    }

    return {
      status: 'defer',
      reason: `Needs ${input.kind} review (fuzzy/architectural or high-risk). Watcher will not self-approve a create.`,
      reviewer_model: `pending:${input.kind}`,
    };
  }
}

export function parseAdmissionDecision(text: string, reviewerModel: string): AdmissionReviewDecision | null {
  let found: AdmissionReviewDecision | null = null;
  for (const candidate of jsonObjectsIn(text)) {
    const raw = typeof candidate.status === 'string' ? candidate.status : candidate.verdict;
    const status = raw === 'approved' || raw === 'approve'
      ? 'approved'
      : raw === 'rejected' || raw === 'reject'
        ? 'rejected'
        : null;
    if (!status) continue;
    found = {
      status,
      reason: typeof candidate.reason === 'string' ? candidate.reason : 'Adapter review',
      reviewer_model: reviewerModel,
    };
  }
  return found;
}

function jsonObjectsIn(text: string): Array<{ status?: string; verdict?: string; reason?: string }> {
  const objects: Array<{ status?: string; verdict?: string; reason?: string }> = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth !== 0) continue;
        try {
          const parsed = JSON.parse(text.slice(i, j + 1)) as Record<string, unknown>;
          if (parsed && typeof parsed === 'object') {
            objects.push(parsed as { status?: string; verdict?: string; reason?: string });
            for (const value of Object.values(parsed)) {
              if (typeof value === 'string' && value.includes('{')) {
                objects.push(...jsonObjectsIn(value));
              }
            }
          }
        } catch {
          // not a JSON object at this span
        }
        break;
      }
    }
  }
  return objects;
}

export class AdapterAdmissionReviewer implements IAdmissionReviewer {
  constructor(
    private readonly resolveAdapter: (kind: AdmissionReviewerKind) => IAgentAdapter | undefined,
    private readonly workspace: string,
    private readonly fallback: IAdmissionReviewer = new HeuristicAdmissionReviewer(),
    private readonly timeoutMs = 120_000,
  ) {}

  async review(input: AdmissionReviewInput): Promise<AdmissionReviewDecision> {
    const heuristic = await this.fallback.review(input);
    if (heuristic.status !== 'defer') return heuristic;
    if (input.kind === 'council') return heuristic;

    const adapter = this.resolveAdapter(input.kind);
    if (!adapter) return heuristic;
    const available = await adapter.test();
    if (!available.ok) return heuristic;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const handle = adapter.execute({
        prompt: [
          'Decide this ORCH admission request. Reply with ONLY JSON:',
          '{"status":"approved"|"rejected","reason":"..."}',
          '',
          `Type: ${input.request.type}`,
          `Proposed: ${JSON.stringify(input.request.proposed)}`,
          `Need: ${input.request.need ?? ''}`,
          `Why not reuse: ${input.request.why_existing_file_is_not_enough ?? ''}`,
          `Existing candidates: ${JSON.stringify(input.request.existing_candidates ?? [])}`,
          `GitNexus hits: ${JSON.stringify(input.hits)}`,
          `Impact: ${input.impact ?? 'unspecified'}`,
          'UNKNOWN or unspecified impact is not LOW. Do not approve until callers are resolved.',
          'HIGH/CRITICAL impact is not automatic approval. Prefer reuse over a new file or symbol.',
          'Reject "cleaner" with no evidence the current owner would become incoherent.',
          'For a new dependency answer: stdlib/platform, existing installed package, internal utility, surface added, maintained.',
          'For a new file answer: can it live in an existing module, who owns this, parallel abstraction, cohesion vs spreading 20 lines.',
          'For a new symbol answer: can it live as a method on the current owner, why a new export, parallel abstraction.',
          'For a scope expansion answer: why the current contract files/symbols cannot absorb the work, who owns the new path.',
          'Reject if a hit is the same path or symbol. Do not write code.',
        ].join('\n'),
        systemPrompt: 'You are the ORCH watcher admission reviewer. Never self-approve as the requesting worker. JSON only.',
        workspace: this.workspace,
        config: {
          approval_policy: 'auto',
          max_turns: 4,
          timeout_ms: this.timeoutMs,
          stall_timeout_ms: this.timeoutMs,
          ...(input.kind === 'codex' ? { effort: 'medium' as const } : {}),
        },
        signal: controller.signal,
      });
      let text = '';
      for await (const event of handle.events) {
        if (event.type === 'output' || event.type === 'done' || event.type === 'error') {
          text += collectAdapterText(event.data);
        }
        if (event.type === 'error') {
          return { status: 'defer', reason: 'Adapter review errored; left pending.', reviewer_model: adapter.kind };
        }
      }
      return parseAdmissionDecision(text, adapter.kind)
        ?? { status: 'defer', reason: 'Adapter did not return JSON; left pending.', reviewer_model: adapter.kind };
    } catch {
      return { status: 'defer', reason: 'Adapter review failed; left pending.', reviewer_model: adapter.kind };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Flatten Claude/Cursor/Codex stream-json envelopes so a JSON verdict can be parsed. */
export function collectAdapterText(data: unknown): string {
  if (data == null) return '';
  if (typeof data === 'string') return data;
  if (typeof data !== 'object') return '';
  const rec = data as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof rec.text === 'string' && rec.text.trim()) parts.push(rec.text);
  if (typeof rec.result === 'string' && rec.result.trim()) parts.push(rec.result);
  if (typeof rec.message === 'string' && rec.message.trim()) parts.push(rec.message);
  if (Array.isArray(rec.content)) {
    parts.push(rec.content.map((part) => collectAdapterText(part)).join(''));
  }
  if (rec.message && typeof rec.message === 'object') parts.push(collectAdapterText(rec.message));
  if (rec.result && typeof rec.result === 'object') parts.push(collectAdapterText(rec.result));
  const joined = parts.join('');
  if (joined) return joined;
  const raw = JSON.stringify(data);
  return /"(?:status|verdict)"\s*:\s*"(?:approved|rejected|approve|reject)"/.test(raw) ? raw : '';
}

export function pickReviewerKind(input: {
  impact?: ImpactRisk;
  councilApprovedPlan: boolean;
  type: AdmissionRequest['type'];
}): AdmissionReviewerKind {
  if (input.councilApprovedPlan && (input.type === 'new_file' || input.type === 'new_dependency')) {
    return 'council';
  }
  if (input.impact === 'high' || input.impact === 'critical') return 'codex';
  return 'claude';
}
