/**
 * Independent multi-model council. Does not schedule ORCH tasks.
 */

import { nanoid } from 'nanoid';
import type { IAgentAdapter } from '../infrastructure/adapters/interface.js';
import { CouncilStore } from '../infrastructure/storage/council-store.js';
import type { CouncilMemberVote, CouncilResult, CouncilVerdict } from '../domain/council.js';
import { planDigest, type PlanManifest } from '../domain/plan.js';
import type { EventBus } from './event-bus.js';
import { collectAdapterText, parseAdmissionDecision } from './admission-reviewer.js';

export interface CouncilMember {
  adapter: string;
  model: string;
  resolve: () => IAgentAdapter | undefined;
}

/** Spec §5.2: Claude + Codex + Cursor Agent (Grok 4.6). Not the Grok CLI.
 *  Do not pin stale Codex model IDs — omit `--model` and let the CLI default. */
export const DEFAULT_COUNCIL_MEMBERS: Array<{ adapter: string; model: string; effort?: 'low' | 'medium' | 'high' }> = [
  { adapter: 'claude', model: 'claude' },
  { adapter: 'codex', model: 'codex', effort: 'medium' },
  { adapter: 'cursor', model: 'grok-4.6', effort: 'high' },
];

export class CouncilService {
  constructor(
    private readonly store: CouncilStore,
    private readonly resolveAdapter: (kind: string) => IAgentAdapter | undefined,
    private readonly workspace: string,
    private readonly timeoutMs = 180_000,
    private readonly eventBus?: EventBus,
  ) {}

  async convene(input: {
    plan: PlanManifest;
    members?: Array<{ adapter: string; model: string }>;
  }): Promise<CouncilResult> {
    this.eventBus?.emit({ type: 'planning:council_started', planId: input.plan.id });
    const members = input.members ?? DEFAULT_COUNCIL_MEMBERS;
    const { listLearnings, renderLearningContext } = await import('./learning-reader.js');
    const notes = await listLearnings(this.workspace);
    this.eventBus?.emit({ type: 'learning:refreshed', goalId: notes[0]?.goal_id });
    const learningBlock = renderLearningContext(notes);
    let votes = await Promise.all(members.map((member) => this.ask(member, input.plan, learningBlock, 1)));
    let verdict = tally(votes);
    let rounds = 1;
    if (verdict === 'revise') {
      const changelog = renderRoundChangelog(votes);
      const roundTwo = await Promise.all(
        members.map((member) => this.ask(member, input.plan, learningBlock, 2, changelog)),
      );
      votes = [...votes, ...roundTwo];
      verdict = tally(votes);
      rounds = 2;
    }
    const latest = votes.filter((vote) => (vote.round ?? 1) === rounds);
    const result: CouncilResult = {
      id: `cnc_${nanoid(7)}`,
      plan_id: input.plan.id,
      plan_digest: input.plan.digest || planDigest(input.plan.title, input.plan.units),
      created_at: new Date().toISOString(),
      rounds,
      votes,
      verdict,
      summary: latest.map((vote) => `${vote.adapter}: ${vote.verdict}`).join('; '),
      gitnexus_evidence: {
        searches: input.plan.reuse.searches,
        candidates: [
          ...input.plan.reuse.candidates.map((item) => (
            item.kind === 'process'
              ? `process:${item.symbol ?? item.path}`
              : `${item.path}${item.symbol ? `#${item.symbol}` : ''}${item.reason.includes('impact ') ? ` ${item.reason.slice(item.reason.indexOf('impact '))}` : ''}`
          )),
          ...input.plan.reuse.proposed_creates.map((item) => (
            `create:${item.kind}:${item.name ?? item.path ?? '?'} alts=${(item.alternatives_considered ?? []).join('|') || 'none'}`
          )),
        ],
        incomplete: input.plan.reuse.incomplete
          || input.plan.reuse.candidates.some((item) => /impact UNKNOWN/.test(item.reason)),
      },
    };
    await this.store.save(result);
    for (const vote of latest) {
      this.eventBus?.emit({
        type: 'planning:council_member_completed',
        planId: input.plan.id,
        adapter: vote.adapter,
        verdict: vote.verdict,
      });
      if (vote.summary.includes('not available') || vote.summary.includes('CLI missing')) {
        this.eventBus?.emit({
          type: 'planning:council_blocked',
          planId: input.plan.id,
          reason: vote.summary,
        });
      }
    }
    this.eventBus?.emit({
      type: 'planning:council_completed',
      planId: input.plan.id,
      councilId: result.id,
      verdict: result.verdict,
    });
    return result;
  }

  private async ask(
    member: { adapter: string; model: string; effort?: 'low' | 'medium' | 'high' },
    plan: PlanManifest,
    learningBlock = '',
    round = 1,
    changelog = '',
  ): Promise<CouncilMemberVote> {
    const adapter = this.resolveAdapter(member.adapter);
    if (!adapter) {
      return {
        model: member.model,
        adapter: member.adapter,
        verdict: 'revise',
        summary: `${member.adapter} is not available — fail-closed, do not treat as approve.`,
        requested_model: member.model,
        fallback: 'unavailable',
        round,
      };
    }
    const available = await adapter.test();
    if (!available.ok) {
      return {
        model: member.model,
        adapter: member.adapter,
        verdict: 'revise',
        summary: `${member.adapter} CLI missing — fail-closed.`,
        requested_model: member.model,
        fallback: 'cli-missing',
        round,
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
          `Round: ${round}`,
          `Plan: ${plan.title} (${plan.units.length} units, route ${plan.route})`,
          `Units: ${plan.units.map((unit) => unit.title).join('; ')}`,
          `Acceptance: ${plan.units.flatMap((unit) => unit.acceptance_criteria).join('; ') || 'none recorded'}`,
          `GitNexus searches: ${plan.reuse.searches.join(', ')}`,
          `Symbols/files: ${plan.reuse.candidates.filter((item) => item.kind !== 'process').map((item) => item.path).join(', ') || 'none'}`,
          `Processes: ${plan.reuse.candidates.filter((item) => item.kind === 'process').map((item) => item.symbol ?? item.path).join(', ') || 'none'}`,
          `Impact: ${plan.reuse.candidates.filter((item) => item.kind !== 'process').map((item) => `${item.symbol ?? item.path}: ${item.reason}`).join(' | ') || 'none'}`,
          `Proposed creates: ${plan.reuse.proposed_creates.map((item) => `${item.kind}:${item.name ?? item.path ?? '?'} why=${item.why_not_reuse}; alts=${(item.alternatives_considered ?? []).join('|') || 'none'}`).join(' || ') || 'none'}`,
          `Incomplete graph: ${plan.reuse.incomplete}`,
          changelog ? `Changelog from prior independent pass (not other members' raw replies):\n${changelog}` : '',
          learningBlock,
          'Inspect reuse independently. Prefer existing symbols over new files. Do not invent consensus.',
        ].filter(Boolean).join('\n'),
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
        if (event.type === 'output' || event.type === 'done' || event.type === 'error') {
          text += collectAdapterText(event.data);
        }
      }
      const parsed = parseAdmissionDecision(text, member.adapter);
      const verdict: CouncilVerdict = parsed?.status === 'approved'
        ? 'approve'
        : parsed?.status === 'rejected'
          ? 'reject'
          : 'revise';
      const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 280);
      const usedCliDefault = member.model === member.adapter;
      return {
        model: member.model,
        adapter: member.adapter,
        verdict,
        summary: parsed?.reason ?? (snippet
          ? `No JSON verdict; counted as revise. Adapter text: ${snippet}`
          : 'No JSON verdict; counted as revise (empty adapter text).'),
        reuse_notes: plan.reuse.candidates.map((item) => item.path),
        requested_model: member.model,
        actual_model: usedCliDefault ? 'cli-default' : member.model,
        fallback: usedCliDefault ? 'cli-default' : undefined,
        round,
      };
    } catch (err) {
      return {
        model: member.model,
        adapter: member.adapter,
        verdict: 'revise',
        summary: err instanceof Error ? err.message : 'Council member failed',
        round,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export { collectAdapterText } from './admission-reviewer.js';

function latestRound(votes: CouncilMemberVote[]): number {
  return votes.reduce((max, vote) => Math.max(max, vote.round ?? 1), 1);
}

function tally(votes: CouncilMemberVote[]): CouncilVerdict {
  const round = latestRound(votes);
  const latest = votes.filter((item) => (item.round ?? 1) === round);
  if (latest.length === 0) return 'revise';
  if (latest.every((vote) => vote.verdict === 'reject')) return 'reject';
  if (latest.every((vote) => vote.verdict === 'approve')) return 'approve';
  return 'revise';
}

function renderRoundChangelog(votes: CouncilMemberVote[]): string {
  const objections = votes
    .filter((vote) => vote.verdict !== 'approve')
    .map((vote) => `- ${vote.adapter}: ${vote.verdict} — ${vote.summary}`);
  return [
    'Strongest objections from the independent first pass (preserved even if later rejected):',
    ...(objections.length > 0 ? objections : ['- none recorded']),
    'Plan units and reuse candidates are unchanged. Do not treat silence as consensus.',
  ].join('\n');
}
