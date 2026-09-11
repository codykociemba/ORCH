/**
 * Independent multi-model council. Does not schedule ORCH tasks.
 */

import { nanoid } from 'nanoid';
import type { IAgentAdapter } from '../infrastructure/adapters/interface.js';
import { CouncilStore } from '../infrastructure/storage/council-store.js';
import type { CouncilMemberVote, CouncilResult, CouncilVerdict } from '../domain/council.js';
import type { PlanManifest } from '../domain/plan.js';
import { parseAdmissionDecision } from './admission-reviewer.js';

export interface CouncilMember {
  adapter: string;
  model: string;
  resolve: () => IAgentAdapter | undefined;
}

const DEFAULT_MEMBERS: Array<{ adapter: string; model: string; effort?: 'low' | 'medium' | 'high' }> = [
  { adapter: 'claude', model: 'claude' },
  { adapter: 'codex', model: 'gpt-5.4', effort: 'medium' },
  { adapter: 'grok', model: 'grok-4.6' },
];

export class CouncilService {
  constructor(
    private readonly store: CouncilStore,
    private readonly resolveAdapter: (kind: string) => IAgentAdapter | undefined,
    private readonly workspace: string,
    private readonly timeoutMs = 180_000,
  ) {}

  async convene(input: {
    plan: PlanManifest;
    members?: Array<{ adapter: string; model: string }>;
  }): Promise<CouncilResult> {
    const members = input.members ?? DEFAULT_MEMBERS;
    const { listLearnings, renderLearningContext } = await import('./learning-reader.js');
    const learningBlock = renderLearningContext(await listLearnings(this.workspace));
    const votes = await Promise.all(members.map((member) => this.ask(member, input.plan, learningBlock)));
    const verdict = tally(votes);
    const result: CouncilResult = {
      id: `cnc_${nanoid(7)}`,
      plan_id: input.plan.id,
      created_at: new Date().toISOString(),
      rounds: 1,
      votes,
      verdict,
      summary: votes.map((vote) => `${vote.adapter}: ${vote.verdict}`).join('; '),
      gitnexus_evidence: {
        searches: input.plan.reuse.searches,
        candidates: input.plan.reuse.candidates.map((item) => `${item.path}${item.symbol ? `#${item.symbol}` : ''}`),
        incomplete: input.plan.reuse.incomplete,
      },
    };
    await this.store.save(result);
    return result;
  }

  private async ask(
    member: { adapter: string; model: string; effort?: 'low' | 'medium' | 'high' },
    plan: PlanManifest,
    learningBlock = '',
  ): Promise<CouncilMemberVote> {
    const adapter = this.resolveAdapter(member.adapter);
    if (!adapter) {
      return {
        model: member.model,
        adapter: member.adapter,
        verdict: 'revise',
        summary: `${member.adapter} is not available — fail-closed, do not treat as approve.`,
      };
    }
    const available = await adapter.test();
    if (!available.ok) {
      return {
        model: member.model,
        adapter: member.adapter,
        verdict: 'revise',
        summary: `${member.adapter} CLI missing — fail-closed.`,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const handle = adapter.execute({
        prompt: [
          'Independent council review of this ORCH/CE plan. Reply ONLY JSON:',
          '{"status":"approved"|"rejected","reason":"..."}',
          'Use approved for approve, rejected for reject. Anything else is revise.',
          `Plan: ${plan.title} (${plan.units.length} units, route ${plan.route})`,
          `Units: ${plan.units.map((unit) => unit.title).join('; ')}`,
          `GitNexus searches: ${plan.reuse.searches.join(', ')}`,
          `Candidates: ${plan.reuse.candidates.map((item) => item.path).join(', ') || 'none'}`,
          `Incomplete graph: ${plan.reuse.incomplete}`,
          learningBlock,
          'Inspect reuse independently. Prefer existing symbols over new files.',
        ].join('\n'),
        systemPrompt: 'You are an independent council member. Do not schedule work. JSON only.',
        workspace: this.workspace,
        config: {
          model: member.model === member.adapter ? undefined : member.model,
          effort: member.effort,
          approval_policy: 'auto',
          max_turns: 6,
          timeout_ms: this.timeoutMs,
          stall_timeout_ms: this.timeoutMs,
        },
        signal: controller.signal,
      });
      let text = '';
      for await (const event of handle.events) {
        if (event.type === 'output' || event.type === 'done') {
          const data = event.data as { text?: string; result?: string };
          text += data.text ?? data.result ?? '';
        }
      }
      const parsed = parseAdmissionDecision(text, member.adapter);
      const verdict: CouncilVerdict = parsed?.status === 'approved'
        ? 'approve'
        : parsed?.status === 'rejected'
          ? 'reject'
          : 'revise';
      return {
        model: member.model,
        adapter: member.adapter,
        verdict,
        summary: parsed?.reason ?? 'No JSON verdict; counted as revise.',
        reuse_notes: plan.reuse.candidates.map((item) => item.path),
      };
    } catch (err) {
      return {
        model: member.model,
        adapter: member.adapter,
        verdict: 'revise',
        summary: err instanceof Error ? err.message : 'Council member failed',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function tally(votes: CouncilMemberVote[]): CouncilVerdict {
  const counts = { approve: 0, revise: 0, reject: 0 };
  for (const vote of votes) counts[vote.verdict] += 1;
  if (counts.reject > 0 && counts.approve === 0) return 'reject';
  if (counts.approve >= 2 && counts.reject === 0) return 'approve';
  return 'revise';
}
