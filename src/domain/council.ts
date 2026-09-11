/**
 * Multi-model council result (planning / high-risk admission).
 */

export type CouncilVerdict = 'approve' | 'revise' | 'reject';

/** Explicit human unlock when a required council cannot approve. */
export const COUNCIL_OVERRIDE_LABEL = 'council-override';

/** Dispatch only after an approve. Revise/reject must not set council_ref. */
export function councilVerdictAllowsDispatch(verdict: CouncilVerdict): boolean {
  return verdict === 'approve';
}

export interface CouncilMemberVote {
  model: string;
  adapter: string;
  verdict: CouncilVerdict;
  summary: string;
  reuse_notes?: string[];
  round?: number;
  requested_model?: string;
  actual_model?: string;
  fallback?: 'unavailable' | 'cli-missing' | 'cli-default';
}

export interface CouncilResult {
  id: string;
  plan_id?: string;
  plan_digest?: string;
  admission_request_id?: string;
  created_at: string;
  rounds: number;
  votes: CouncilMemberVote[];
  verdict: CouncilVerdict;
  summary: string;
  gitnexus_evidence?: {
    searches: string[];
    candidates: string[];
    incomplete: boolean;
  };
  /** Human unlock only. Never rewrite verdict to approve. */
  human_override?: {
    reason: string;
    at: string;
    actor: 'human';
    task_ids?: string[];
  };
}

export function strongestCouncilObjections(votes: CouncilMemberVote[]): string[] {
  return votes
    .filter((vote) => vote.verdict !== 'approve')
    .map((vote) => `${vote.adapter}/${vote.model} (r${vote.round ?? 1}): ${vote.verdict} — ${vote.summary}`);
}

/** Human-readable council report for docs/plans/<plan>-council.md */
export function renderCouncilMarkdown(result: CouncilResult): string {
  const evidence = result.gitnexus_evidence;
  const objections = strongestCouncilObjections(result.votes);
  const byRound = new Map<number, CouncilMemberVote[]>();
  for (const vote of result.votes) {
    const round = vote.round ?? 1;
    const bucket = byRound.get(round) ?? [];
    bucket.push(vote);
    byRound.set(round, bucket);
  }
  const roundBlocks = [...byRound.entries()].sort(([a], [b]) => a - b).flatMap(([round, votes]) => [
    `## Round ${round}`,
    '',
    ...votes.flatMap((vote) => [
      `### ${vote.adapter} / ${vote.model}`,
      `- Verdict: ${vote.verdict}`,
      vote.fallback ? `- Fallback: ${vote.fallback}${vote.actual_model ? ` (actual ${vote.actual_model})` : ''}` : '',
      `- Summary: ${vote.summary}`,
      ...(vote.reuse_notes ?? []).map((note) => `- Reuse: ${note}`),
      '',
    ].filter(Boolean)),
  ]);
  return [
    `# Council: ${result.plan_id ?? result.id}`,
    '',
    `- Id: \`${result.id}\``,
    `- Verdict: **${result.verdict}**`,
    result.plan_digest ? `- Plan digest: \`${result.plan_digest}\`` : '',
    `- Rounds: ${result.rounds}`,
    `- Created: ${result.created_at}`,
    result.summary ? `- Summary: ${result.summary}` : '',
    '',
    ...roundBlocks,
    '## Strongest objections',
    '',
    ...(objections.length > 0 ? objections.map((item) => `- ${item}`) : ['- none recorded']),
    '',
    '## GitNexus evidence',
    '',
    evidence
      ? [
          `- Incomplete: ${evidence.incomplete}`,
          `- Searches: ${evidence.searches.join(', ') || 'none'}`,
          `- Candidates: ${evidence.candidates.join(', ') || 'none'}`,
        ].join('\n')
      : '- none recorded',
    '',
    '## Human override',
    '',
    result.human_override
      ? [
          `- Actor: ${result.human_override.actor}`,
          `- At: ${result.human_override.at}`,
          `- Reason: ${result.human_override.reason}`,
          result.human_override.task_ids?.length
            ? `- Tasks: ${result.human_override.task_ids.join(', ')}`
            : '',
          '- Does not fabricate an approve or authorize new files.',
        ].filter(Boolean).join('\n')
      : '- none recorded',
    '',
    '## Status',
    '',
    councilVerdictAllowsDispatch(result.verdict)
      ? 'Approved — matching plan tasks may dispatch.'
      : result.human_override
        ? 'Not approved — human override unlocks dispatch only; council verdict is unchanged.'
        : 'Not approved — dispatch stays blocked unless a human records `council-override`.',
    '',
  ].filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n');
}
