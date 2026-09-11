/**
 * Aggregate verification + admission evidence and render proof bodies.
 */

import type { Task } from '../domain/task.js';
import type { VerificationEvidence } from '../domain/evidence.js';
import type { AdmissionAuditResult } from '../domain/admission.js';
import { renderGitHubProof, renderLinearProof } from '../infrastructure/proof/renderers.js';

export class ProofService {
  build(input: {
    task: Task;
    audit?: AdmissionAuditResult;
    headSha?: string;
    checks?: VerificationEvidence['checks'];
    reviews?: VerificationEvidence['reviews'];
  }): VerificationEvidence {
    const admission = input.audit
      ? {
          passed: input.audit.passed,
          incomplete: input.audit.incomplete,
          violations: input.audit.violations.map((item) => item.message),
        }
      : input.task.proof
        ? undefined
        : undefined;

    const checks = input.checks ?? [];
    const reviews = input.reviews ?? input.task.reviews ?? [];
    const admissionOk = !admission || (admission.passed && !admission.incomplete);
    const checksOk = checks.every((check) => check.status !== 'failed');
    const shaOk = !!input.headSha;
    const shaUnchanged = !input.task.proof?.head_sha || !input.headSha || input.task.proof.head_sha === input.headSha;
    const verified = admissionOk && checksOk && shaOk && shaUnchanged;

    return {
      task_id: input.task.id,
      branch: input.task.proof?.branch,
      pr_url: input.task.external?.github?.pr_url ?? input.task.proof?.pr_url,
      head_sha: input.headSha,
      files_changed: input.task.proof?.files_changed ?? [],
      checks,
      reviews,
      acceptance_criteria: (input.task.acceptance_criteria ?? []).map((description) => ({
        description,
        passed: checksOk && admissionOk,
      })),
      agent_summary: input.task.proof?.agent_summary,
      admission,
      verified,
      verified_at: verified ? new Date().toISOString() : undefined,
    };
  }

  renderGitHub(evidence: VerificationEvidence): string {
    return renderGitHubProof(evidence);
  }

  renderLinear(evidence: VerificationEvidence): string {
    return renderLinearProof(evidence);
  }
}
