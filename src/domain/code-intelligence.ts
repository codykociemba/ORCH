/**
 * Code-intelligence DTOs.
 *
 * GitNexus (or a future provider) fills these. ORCH policy must not
 * import GitNexus types directly.
 */

export interface RepositoryIdentityInput {
  repository_root: string;
  worktree_path?: string;
  repo?: string;
}

export interface CodeIndexStatus {
  provider: 'gitnexus';
  repo: string;
  available: boolean;
  current: boolean;
  index_commit?: string;
  incomplete_reasons: string[];
  raw?: unknown;
}

export interface ExistingCodeSearchInput {
  query: string;
  repo?: string;
  worktree?: string;
  limit?: number;
}

export interface CodeCandidate {
  symbol?: string;
  path: string;
  kind?: string;
  score?: number;
  snippet?: string;
}

export interface SymbolContextInput {
  symbol: string;
  path?: string;
  repo?: string;
  worktree?: string;
}

export interface SymbolContext {
  symbol: string;
  path?: string;
  kind?: string;
  callers: string[];
  callees: string[];
  processes: string[];
  raw?: unknown;
}

export interface ImpactInput {
  target: string;
  direction?: 'upstream' | 'downstream' | 'both';
  repo?: string;
  worktree?: string;
}

export type ImpactRisk = 'low' | 'medium' | 'high' | 'critical' | 'unknown';

export interface ImpactReport {
  target: string;
  risk: ImpactRisk;
  direct_dependents: number;
  total_dependents: number;
  processes: string[];
  unresolved: boolean;
  raw?: unknown;
}

export interface ProcessQueryInput {
  query?: string;
  repo?: string;
  worktree?: string;
}

export interface ExecutionProcess {
  name: string;
  steps: string[];
}

export interface DetectCodeChangesInput {
  repo?: string;
  worktree: string;
  scope?: 'all' | 'unstaged' | 'staged';
  base_sha?: string;
}

export interface SemanticSymbolChange {
  name: string;
  path?: string;
  kind?: string;
  change: 'added' | 'modified' | 'deleted';
}

export interface SemanticChangeSet {
  added_symbols: SemanticSymbolChange[];
  modified_symbols: SemanticSymbolChange[];
  deleted_symbols: SemanticSymbolChange[];
  processes: string[];
  risk?: ImpactRisk;
  partial: boolean;
  truncated: boolean;
  degraded: boolean;
  worktree: string;
  raw?: unknown;
}
