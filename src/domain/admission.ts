/**
 * Code admission requests, reservations, and audit results.
 */

export type AdmissionRequestType =
  | 'new_file'
  | 'new_symbol'
  | 'new_dependency'
  | 'scope_expansion'
  | 'high_risk_edit';

export type AdmissionRequestStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'redirected'
  | 'pending_llm';

export interface AdmissionRequest {
  id: string;
  task_id: string;
  type: AdmissionRequestType;
  requested_at: string;
  proposed: {
    kind?: string;
    name?: string;
    path?: string;
    package?: string;
  };
  need?: string;
  gitnexus_searches?: string[];
  existing_candidates?: Array<{
    symbol?: string;
    path: string;
    why_not_reuse?: string;
  }>;
  why_existing_file_is_not_enough?: string;
  estimated_size?: string;
  decision?: {
    status: Exclude<AdmissionRequestStatus, 'pending' | 'pending_llm'>;
    decided_at: string;
    decided_by: string;
    reason: string;
    reviewer_model?: string;
    redirect?: {
      path: string;
      name?: string;
      reserved_by_task?: string;
    };
  };
  status: AdmissionRequestStatus;
}

export interface Reservation {
  key: string;
  kind: 'file' | 'symbol' | 'dependency';
  path?: string;
  name?: string;
  package?: string;
  task_id: string;
  request_id?: string;
  created_at: string;
}

export interface ReservationTable {
  version: 1;
  items: Reservation[];
}

export interface AdmissionAuditViolation {
  kind: 'unapproved_file' | 'unapproved_symbol' | 'unapproved_dependency' | 'incomplete_audit' | 'wrong_worktree';
  message: string;
  path?: string;
  name?: string;
}

export interface AdmissionAuditResult {
  passed: boolean;
  incomplete: boolean;
  violations: AdmissionAuditViolation[];
  added_files: string[];
  added_symbols: string[];
  deleted_symbols?: string[];
  processes?: string[];
}

export function reservationKey(kind: Reservation['kind'], input: { path?: string; name?: string; package?: string }): string {
  if (kind === 'file') return `file:${normalizePath(input.path ?? '')}`;
  if (kind === 'dependency') return `dep:${(input.package ?? '').toLowerCase()}`;
  const name = (input.name ?? '').trim();
  const path = normalizePath(input.path ?? '');
  return path ? `symbol:${path}#${name}` : `symbol:#${name}`;
}

export function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

export function nameKey(name: string): string {
  return name.trim().toLowerCase();
}
