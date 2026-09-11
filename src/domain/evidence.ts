/**
 * Structured verification evidence (original spec §8.1).
 * Extends TaskProof without discarding legacy fields.
 */

export interface CheckEvidence {
  name: string;
  command?: string;
  status: 'passed' | 'failed' | 'skipped';
  exit_code?: number;
  summary?: string;
  output_path?: string;
  duration_ms?: number;
}

export interface ReviewEvidence {
  reviewer_type: 'human' | 'cursor' | 'codex' | 'claude' | 'other';
  reviewer?: string;
  model?: string;
  commit_sha: string;
  verdict: 'approve' | 'changes_requested' | 'commented' | 'failed';
  summary: string;
  url?: string;
  timestamp: string;
}

export interface VerificationEvidence {
  task_id: string;
  plan_id?: string;
  plan_unit_id?: string;
  branch?: string;
  pr_url?: string;
  head_sha?: string;
  files_changed: string[];
  checks: CheckEvidence[];
  reviews: ReviewEvidence[];
  acceptance_criteria: Array<{
    description: string;
    passed: boolean;
    evidence?: string;
  }>;
  agent_summary?: string;
  council_ref?: string;
  learning_refs?: string[];
  admission?: {
    passed: boolean;
    incomplete: boolean;
    violations: string[];
  };
  verified: boolean;
  verified_at?: string;
}

export type { TaskExternalRefs } from './task.js';
