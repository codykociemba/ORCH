/**
 * Parse Cursor CLI review output. Malformed JSON fails closed (not approve).
 */

export type CursorReviewVerdictKind = 'approve' | 'changes_requested' | 'failed';

export interface CursorReviewResult {
  verdict: CursorReviewVerdictKind;
  summary: string;
  blocking_findings: string[];
  non_blocking_findings: string[];
  missing_tests: string[];
  plan_deviations: string[];
  commit_sha?: string;
}

const EMPTY_LISTS = {
  blocking_findings: [] as string[],
  non_blocking_findings: [] as string[],
  missing_tests: [] as string[],
  plan_deviations: [] as string[],
};

export function parseCursorReview(text: string, commitSha?: string): CursorReviewResult {
  if (!commitSha) {
    return {
      verdict: 'failed',
      summary: 'Review has no commit SHA — fail closed, do not approve.',
      ...EMPTY_LISTS,
    };
  }
  const match = text.match(/\{[\s\S]*"verdict"\s*:\s*"(approve|changes_requested)"[\s\S]*\}/);
  if (!match?.[0]) {
    return {
      verdict: 'failed',
      summary: 'Cursor reviewer returned no parseable JSON — fail closed, do not approve.',
      ...EMPTY_LISTS,
      commit_sha: commitSha,
    };
  }
  try {
    const parsed = JSON.parse(match[0]) as {
      verdict?: string;
      summary?: string;
      blocking_findings?: unknown;
      non_blocking_findings?: unknown;
      missing_tests?: unknown;
      plan_deviations?: unknown;
    };
    if (parsed.verdict !== 'approve' && parsed.verdict !== 'changes_requested') {
      return {
        verdict: 'failed',
        summary: 'Cursor reviewer verdict was not approve|changes_requested — fail closed.',
        ...EMPTY_LISTS,
        commit_sha: commitSha,
      };
    }
    if (parsed.verdict === 'approve' && asStringList(parsed.blocking_findings).length > 0) {
      return {
        verdict: 'changes_requested',
        summary: parsed.summary ?? 'Blocking findings present — cannot approve.',
        blocking_findings: asStringList(parsed.blocking_findings),
        non_blocking_findings: asStringList(parsed.non_blocking_findings),
        missing_tests: asStringList(parsed.missing_tests),
        plan_deviations: asStringList(parsed.plan_deviations),
        commit_sha: commitSha,
      };
    }
    return {
      verdict: parsed.verdict,
      summary: parsed.summary ?? 'Cursor review',
      blocking_findings: asStringList(parsed.blocking_findings),
      non_blocking_findings: asStringList(parsed.non_blocking_findings),
      missing_tests: asStringList(parsed.missing_tests),
      plan_deviations: asStringList(parsed.plan_deviations),
      commit_sha: commitSha,
    };
  } catch {
    return {
      verdict: 'failed',
      summary: 'Cursor reviewer JSON was malformed — fail closed.',
      ...EMPTY_LISTS,
      commit_sha: commitSha,
    };
  }
}

export function toReviewEvidence(
  result: CursorReviewResult,
  input: { commitSha: string; url?: string; reviewer?: string },
): import('../domain/evidence.js').ReviewEvidence {
  const commitSha = result.commit_sha || input.commitSha;
  return {
    reviewer_type: 'cursor',
    reviewer: input.reviewer ?? 'cursor-cli',
    model: 'grok-4.6',
    commit_sha: commitSha,
    verdict: !commitSha
      ? 'failed'
      : result.verdict === 'approve' ? 'approve' : result.verdict === 'changes_requested' ? 'changes_requested' : 'failed',
    summary: !commitSha
      ? 'Review has no commit SHA — fail closed, do not approve.'
      : result.summary,
    url: input.url,
    timestamp: new Date().toISOString(),
    blocking_findings: result.blocking_findings,
    plan_deviations: result.plan_deviations,
  } as import('../domain/evidence.js').ReviewEvidence;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}
