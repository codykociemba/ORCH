/**
 * Multi-model council result (planning / high-risk admission).
 */

export type CouncilVerdict = 'approve' | 'revise' | 'reject';

export interface CouncilMemberVote {
  model: string;
  adapter: string;
  verdict: CouncilVerdict;
  summary: string;
  reuse_notes?: string[];
}

export interface CouncilResult {
  id: string;
  plan_id?: string;
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
}
