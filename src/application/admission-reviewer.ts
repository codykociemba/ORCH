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
    if (input.councilApprovedPlan && (input.request.type === 'new_file' || input.request.type === 'new_dependency')) {
      return {
        status: 'defer',
        reason: 'Material create on a Council-approved plan — Council or Codex minimum.',
        reviewer_model: 'policy:council',
      };
    }

    if (input.impact === 'unknown') {
      return {
        status: 'rejected',
        reason: 'UNKNOWN impact is not treated as LOW. Resolve callers before creating/editing.',
        reviewer_model: 'policy:unknown',
      };
    }

    if (input.request.type === 'high_risk_edit' && (input.impact === 'low' || input.impact === 'medium' || input.impact === undefined)) {
      return {
        status: 'approved',
        reason: 'Impact policy: low/medium existing-symbol edits are automatic.',
        reviewer_model: 'policy:impact',
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
  const match = text.match(/\{[\s\S]*"status"\s*:\s*"(approved|rejected)"[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { status?: string; reason?: string };
    if (parsed.status !== 'approved' && parsed.status !== 'rejected') return null;
    return {
      status: parsed.status,
      reason: parsed.reason ?? 'Adapter review',
      reviewer_model: reviewerModel,
    };
  } catch {
    return null;
  }
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
          `GitNexus hits: ${JSON.stringify(input.hits)}`,
          `Impact: ${input.impact ?? 'unspecified'}`,
          'Reject if a hit is the same path or symbol. Do not write code.',
        ].join('\n'),
        systemPrompt: 'You are the ORCH watcher admission reviewer. Never self-approve as the requesting worker. JSON only.',
        workspace: this.workspace,
        config: {
          approval_policy: 'auto',
          max_turns: 4,
          timeout_ms: this.timeoutMs,
          stall_timeout_ms: this.timeoutMs,
        },
        signal: controller.signal,
      });
      let text = '';
      for await (const event of handle.events) {
        if (event.type === 'output' || event.type === 'done') {
          text += extractEventText(event.data);
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

function extractEventText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    const record = data as { text?: unknown; result?: unknown; message?: unknown };
    if (typeof record.text === 'string') return record.text;
    if (typeof record.result === 'string') return record.result;
    if (typeof record.message === 'string') return record.message;
  }
  return '';
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
