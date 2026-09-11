/**
 * H5 — small-plan Codex reuse questions. Fail closed on incomplete graph or unsearched creates.
 */

import type { PlanManifest } from '../domain/plan.js';
import type { IAgentAdapter } from '../infrastructure/adapters/interface.js';
import { parseAdmissionDecision } from './admission-reviewer.js';

export interface SmallPlanReuseVerdict {
  ok: boolean;
  notes: string[];
  questions: string[];
}

export const SMALL_PLAN_REUSE_QUESTIONS = [
  'Did Claude discover the existing implementation seams?',
  'Is any proposed new file/function actually necessary?',
  'Is modifying the chosen existing symbol safer than creating a new parallel path?',
  'Did the plan miss a shared helper/service?',
] as const;

export function verifySmallPlanReuse(plan: PlanManifest): SmallPlanReuseVerdict {
  const notes: string[] = [];
  let ok = true;

  if (plan.reuse.incomplete) {
    ok = false;
    notes.push('GitNexus index is incomplete — do not authorize creates from this reuse analysis.');
  }

  if (plan.reuse.proposed_creates.length > 0 && plan.reuse.searches.length === 0) {
    ok = false;
    notes.push('Proposed creates without GitNexus searches — existing seams were not checked.');
  }

  if (plan.reuse.proposed_creates.length > 0 && plan.reuse.candidates.length === 0 && !plan.reuse.incomplete) {
    notes.push('No GitNexus candidates; proposed creates still need plan/admission authorization.');
  }

  if (plan.reuse.recommended_edits.length > 0) {
    notes.push(`Reuse first: ${plan.reuse.recommended_edits.map((item) => item.symbol ?? item.path).join(', ')}`);
  }

  return {
    ok,
    notes,
    questions: [...SMALL_PLAN_REUSE_QUESTIONS],
  };
}

export async function verifySmallPlanWithCodex(
  plan: PlanManifest,
  adapter: IAgentAdapter | undefined,
  workspace: string,
): Promise<SmallPlanReuseVerdict> {
  const base = verifySmallPlanReuse(plan);
  if (plan.units.length > 2) return base;
  if (!adapter) {
    return {
      ok: false,
      notes: [...base.notes, 'Codex is not available — small-plan reuse check fail-closed.'],
      questions: base.questions,
    };
  }
  const available = await adapter.test();
  if (!available.ok) {
    return {
      ok: false,
      notes: [...base.notes, available.error ?? 'Codex CLI missing — small-plan reuse check fail-closed.'],
      questions: base.questions,
    };
  }
  try {
    const handle = adapter.execute({
      prompt: [
        'Independent Codex reuse verification of this 1–2 unit ORCH/CE plan. Reply ONLY JSON:',
        '{"status":"approved"|"rejected","reason":"..."}',
        ...base.questions,
        `Plan: ${plan.title}`,
        `Searches: ${plan.reuse.searches.join(', ') || 'none'}`,
        `Candidates: ${plan.reuse.candidates.map((item) => item.path).join(', ') || 'none'}`,
        `Proposed creates: ${plan.reuse.proposed_creates.map((item) => item.name ?? item.path).join(', ') || 'none'}`,
      ].join('\n'),
      systemPrompt: 'You verify reuse. Prefer existing symbols. JSON only.',
      workspace,
      config: { approval_policy: 'auto', effort: 'medium', max_turns: 6, timeout_ms: 180_000, stall_timeout_ms: 180_000 },
    });
    let text = '';
    for await (const event of handle.events) {
      if (event.type === 'output' || event.type === 'done') {
        const data = event.data as { text?: string; result?: string };
        text += data.text ?? data.result ?? '';
      }
    }
    const parsed = parseAdmissionDecision(text, 'codex');
    if (parsed?.status !== 'approved') {
      return {
        ok: false,
        notes: [...base.notes, parsed?.reason ?? 'Codex did not approve reuse — fail-closed.'],
        questions: base.questions,
      };
    }
    return {
      ok: base.ok,
      notes: [...base.notes, parsed.reason],
      questions: base.questions,
    };
  } catch (err) {
    return {
      ok: false,
      notes: [...base.notes, err instanceof Error ? err.message : 'Codex verify failed'],
      questions: base.questions,
    };
  }
}
