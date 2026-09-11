/**
 * Modification Contract — what a worker may edit or create.
 */

import type { CodeIndexStatus } from './code-intelligence.js';

export type AdmissionDecisionStatus = 'approved' | 'denied' | 'pending';

export interface ExistingCodeCandidate {
  symbol?: string;
  path: string;
  kind?: string;
  relevance: 'high' | 'medium' | 'low';
  decision: 'reuse' | 'modify' | 'not_suitable' | 'investigate';
  reason: string;
  gitnexus_ref?: {
    repo?: string;
    symbol_id?: string;
  };
}

export interface AllowedSymbolEdit {
  symbol: string;
  path: string;
  expected_change: string;
  impact?: {
    risk: string;
    direct_dependents?: number;
    total_dependents?: number;
    processes?: string[];
  };
}

export interface AllowedNewSymbol {
  name: string;
  kind:
    | 'function'
    | 'class'
    | 'method'
    | 'interface'
    | 'type'
    | 'constant'
    | 'module'
    | 'other';
  path: string;
  reason: string;
  alternatives_considered: ExistingCodeCandidate[];
  approved_by: string;
  approved_at: string;
}

export interface AllowedNewFile {
  path: string;
  reason: string;
  why_existing_files_are_not_suitable: string;
  approved_by: string;
  approved_at: string;
}

export interface AllowedDependency {
  package: string;
  version_constraint?: string;
  reason: string;
  alternatives_considered: string[];
  approved_by: string;
  approved_at: string;
}

export interface ModificationContract {
  version: 1;
  task_id: string;
  goal_id?: string;
  plan_id?: string;
  plan_unit_id?: string;
  plan_digest?: string;
  base_sha: string;
  source: 'fast_path' | 'planned' | 'admission';
  code_index: {
    provider: 'gitnexus';
    repo: string;
    index_commit: string;
    index_current: boolean;
    generated_at: string;
  };
  existing_code_considered: ExistingCodeCandidate[];
  allowed_existing_edits: AllowedSymbolEdit[];
  allowed_new_symbols: AllowedNewSymbol[];
  allowed_new_files: AllowedNewFile[];
  allowed_dependencies: AllowedDependency[];
  allowed_paths?: string[];
  forbidden_paths?: string[];
  notes?: string[];
  status: 'draft' | 'approved' | 'superseded';
}

export function emptyCreateLists(): Pick<
  ModificationContract,
  'allowed_new_symbols' | 'allowed_new_files' | 'allowed_dependencies'
> {
  return {
    allowed_new_symbols: [],
    allowed_new_files: [],
    allowed_dependencies: [],
  };
}

export function indexFromStatus(status: CodeIndexStatus, generatedAt: string): ModificationContract['code_index'] {
  return {
    provider: 'gitnexus',
    repo: status.repo,
    index_commit: status.index_commit ?? '',
    index_current: status.current,
    generated_at: generatedAt,
  };
}
