/**
 * GitHub / Linear proof section renderers.
 */

import type { VerificationEvidence } from '../../domain/evidence.js';

export function renderGitHubProof(evidence: VerificationEvidence): string {
  const admission = evidence.admission
    ? [
        '### Code admission',
        evidence.admission.passed ? 'PASS' : 'FAIL',
        evidence.admission.incomplete ? 'Incomplete audit (fail-closed).' : '',
        ...evidence.admission.violations.map((item) => `- ${item}`),
      ].filter(Boolean)
    : [];

  return [
    '## ORCH verification proof',
    evidence.verified ? '**Verified**' : '**Not verified**',
    evidence.head_sha ? `HEAD: \`${evidence.head_sha}\`` : 'HEAD: missing (invalidates Verified)',
    evidence.branch ? `Branch: \`${evidence.branch}\`` : '',
    '',
    '### Checks',
    ...evidence.checks.map((check) => `- ${check.name}: ${check.status}`),
    evidence.checks.length === 0 ? '- none recorded' : '',
    '',
    '### Review',
    ...evidence.reviews.map((review) => `- ${review.reviewer_type} @ ${review.commit_sha.slice(0, 7)}: ${review.verdict} — ${review.summary}`),
    evidence.reviews.length === 0 ? '- none recorded' : '',
    '',
    '### Acceptance criteria',
    ...evidence.acceptance_criteria.map((item) => `- ${item.passed ? 'PASS' : 'OPEN'}: ${item.description}`),
    evidence.acceptance_criteria.length === 0 ? '- none recorded' : '',
    '',
    ...admission,
  ].filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n');
}

export function renderLinearProof(evidence: VerificationEvidence): string {
  return [
    'ORCH proof',
    `Task: ${evidence.task_id}`,
    `Verified: ${evidence.verified ? 'yes' : 'no'}`,
    evidence.head_sha ? `SHA: ${evidence.head_sha}` : 'SHA: missing',
    evidence.admission
      ? `Admission: ${evidence.admission.passed ? 'PASS' : 'FAIL'}`
      : '',
    ...(evidence.admission?.violations ?? []).map((item) => ` - ${item}`),
  ].filter(Boolean).join('\n');
}
