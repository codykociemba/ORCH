/**
 * H5 — GitNexus reuse analysis for planned / non-trivial work.
 */

import type { ICodeIntelligence } from '../infrastructure/code-intelligence/interface.js';
import type { ReuseAnalysis } from '../domain/plan.js';
import type { ExistingCodeCandidate } from '../domain/modification-contract.js';
import type { RepositoryIdentityInput } from '../domain/code-intelligence.js';

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

    const sensitive = searches.some((query) =>
      /\b(security|auth|payments?|concurrency|dataflow(?:-sensitive)?)\b/i.test(query),
    );
    if (sensitive) {
      const run = this.intelligence.analyze;
      if (typeof run !== 'function') {
        incomplete = true;
        reasons.push('PDG required for security/auth/payments/concurrency/dataflow-sensitive reuse');
      } else {
        try {
          await run({
            repository_root: this.projectRoot,
            worktree_path: input.worktree,
            pdg: true,
          } as RepositoryIdentityInput);
          reasons.push('PDG analyze requested for security/auth/payments/concurrency/dataflow-sensitive reuse');
        } catch {
          incomplete = true;
          reasons.push('PDG required for security/auth/payments/concurrency/dataflow-sensitive reuse — gitnexus analyze --pdg failed');
        }
      }
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
          decision: (hit.score ?? 0) >= 0.8 ? 'reuse' : 'investigate',
          reason: hit.snippet?.startsWith('reserved by')
            ? `Admission ledger reservation (${hit.snippet})`
            : `GitNexus hit for "${query}"`,
        });
      }
      try {
        const processes = await this.intelligence.getProcesses({
          query,
          worktree: input.worktree ?? this.projectRoot,
        });
        for (const process of processes) {
          if (!process.name || process.name === 'unknown') continue;
          candidates.push({
            symbol: process.name,
            path: process.steps.find((step) => step.includes('/') || step.includes('\\')) ?? process.steps[0] ?? 'process',
            kind: 'process',
            relevance: 'medium',
            decision: 'investigate',
            reason: `GitNexus process for "${query}"`,
          });
        }
      } catch {
        incomplete = true;
        reasons.push(`GitNexus processes unavailable for "${query}"`);
      }
    }

    try {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const raw = JSON.parse(
        await readFile(join(this.projectRoot, '.orchestry', 'admission', 'reservations.json'), 'utf8'),
      ) as {
        items?: Array<{ path?: string; name?: string; package?: string; kind?: string; task_id?: string }>;
      };
      const seen = new Set(candidates.map((item) => `${item.path}#${item.symbol ?? ''}`));
      for (const row of raw.items ?? []) {
        const hay = `${row.path ?? ''} ${row.name ?? ''} ${row.package ?? ''}`.toLowerCase();
        if (!searches.some((query) => hay.includes(query.toLowerCase()))) continue;
        const reservedPath = row.path ?? row.package ?? '';
        const key = `${reservedPath}#${row.name ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
          symbol: row.name,
          path: reservedPath,
          kind: row.kind,
          relevance: 'high',
          decision: 'reuse',
          reason: `Admission ledger reservation (reserved by ${row.task_id ?? 'unknown'})`,
        });
      }
    } catch {
      // plan draft / orch plan reuse still work when the ledger file is missing
    }

    const seenImpact = new Set<string>();
    for (const candidate of candidates) {
      if (candidate.kind === 'process' || !candidate.symbol) continue;
      const key = candidate.symbol.toLowerCase();
      if (seenImpact.has(key)) continue;
      seenImpact.add(key);
      try {
        const impact = await this.intelligence.getImpact({
          target: candidate.symbol,
          direction: 'upstream',
          worktree: input.worktree ?? this.projectRoot,
        });
        const extra: string[] = [];
        const rawObj = impact.raw && typeof impact.raw === 'object' && !Array.isArray(impact.raw)
          ? impact.raw as Record<string, unknown>
          : {};
        for (const key of ['processes', 'affected_processes']) {
          const rows = rawObj[key];
          if (!Array.isArray(rows)) continue;
          for (const item of rows) {
            if (typeof item === 'string' && item) extra.push(item);
            else if (item && typeof item === 'object' && !Array.isArray(item)) {
              const row = item as Record<string, unknown>;
              const name = [row['process'], row['label'], row['name'], row['symbol']].find((value) => typeof value === 'string' && value);
              if (typeof name === 'string') extra.push(name);
            }
          }
        }
        const processes = [...new Set([...impact.processes, ...extra])];
        candidate.reason = `${candidate.reason} (impact ${impact.risk.toUpperCase()}, ${impact.direct_dependents} dependents, processes: ${processes.join(', ') || 'none'})`;
        if (impact.risk === 'unknown' || impact.unresolved) {
          incomplete = true;
          reasons.push(`UNKNOWN impact for ${candidate.symbol} is not treated as LOW`);
          candidate.decision = 'investigate';
        } else if (impact.risk === 'high' || impact.risk === 'critical') {
          candidate.decision = 'investigate';
          candidate.reason = `${candidate.reason} — ${impact.risk.toUpperCase()} requires approval before treating reuse as automatic`;
        }
      } catch {
        incomplete = true;
        reasons.push(`GitNexus impact unavailable for ${candidate.symbol}`);
      }
    }

    return {
      searches,
      candidates,
      recommended_edits: candidates
        .filter((item) => item.relevance === 'high' && item.decision === 'reuse' && item.kind !== 'process')
        .map((item) => ({
          path: item.path,
          symbol: item.symbol,
          reason: item.reason,
        })),
      proposed_creates: searches
        .filter((query) => isIdentifierQuery(query))
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

/** Goal titles and acceptance sentences may be searched; they are not create names. */
function isIdentifierQuery(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return false;
  return trimmed.split(/\s+/).length <= 4;
}
