/**
 * H5 — GitNexus reuse analysis for planned / non-trivial work.
 */

import type { ICodeIntelligence } from '../infrastructure/code-intelligence/interface.js';
import type { ReuseAnalysis } from '../domain/plan.js';
import type { ExistingCodeCandidate } from '../domain/modification-contract.js';

export class ReuseAnalysisService {
  constructor(
    private readonly intelligence: ICodeIntelligence,
    private readonly projectRoot: string,
  ) {}

  async analyze(input: {
    queries: string[];
    worktree?: string;
  }): Promise<ReuseAnalysis> {
    const searches = [...new Set(input.queries.map((item) => item.trim()).filter(Boolean))];
    const candidates: ExistingCodeCandidate[] = [];
    const reasons: string[] = [];
    let incomplete = false;

    const status = await this.intelligence.getRepositoryStatus({
      repository_root: this.projectRoot,
      worktree_path: input.worktree,
    });
    if (!status.available || !status.current) {
      incomplete = true;
      reasons.push(status.incomplete_reasons.join('; ') || 'GitNexus index is not current');
    }

    for (const query of searches) {
      const hits = await this.intelligence.searchExisting({
        query,
        worktree: input.worktree ?? this.projectRoot,
      });
      for (const hit of hits) {
        candidates.push({
          symbol: hit.symbol,
          path: hit.path,
          kind: hit.kind,
          relevance: (hit.score ?? 0) >= 0.8 ? 'high' : (hit.score ?? 0) >= 0.4 ? 'medium' : 'low',
          decision: 'investigate',
          reason: `GitNexus hit for "${query}"`,
        });
      }
    }

    return {
      searches,
      candidates,
      recommended_edits: candidates
        .filter((item) => item.relevance === 'high')
        .map((item) => ({
          path: item.path,
          symbol: item.symbol,
          reason: item.reason,
        })),
      proposed_creates: searches
        .filter((query) => !candidates.some((item) =>
          item.path.includes(query) || (item.symbol ?? '').toLowerCase() === query.toLowerCase(),
        ))
        .filter(() => !incomplete)
        .map((query) => {
          const asPath = query.includes('/') || query.includes('.');
          return {
            kind: asPath ? 'file' as const : 'symbol' as const,
            name: asPath ? undefined : query,
            path: asPath ? query : undefined,
            why_not_reuse: `GitNexus returned no candidates for "${query}". Plan must still authorize this create.`,
            alternatives_considered: candidates.map((item) => item.symbol ?? item.path),
          };
        }),
      incomplete,
      reasons,
    };
  }
}
