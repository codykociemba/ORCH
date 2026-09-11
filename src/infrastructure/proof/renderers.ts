/**
 * GitHub / Linear proof section renderers.
 */

import type { VerificationEvidence } from '../../domain/evidence.js';

type AdmissionProofExtra = {
  existing_candidates?: number;
  reused_symbols?: string[];
  modified_existing_symbols?: string[];
  approved_new_files?: string[];
  actual_new_files?: string[];
  approved_new_symbols?: string[];
  actual_new_symbols?: string[];
  approved_dependencies?: string[];
  actual_new_dependencies?: string[];
  affected_processes?: string[];
  impact_risk?: string;
  index_current?: boolean;
  index_commit?: string;
};

function gitnexusIndexLine(
  extra: AdmissionProofExtra,
  wiki?: VerificationEvidence['wiki'],
): { current?: boolean; sha?: string } {
  return {
    current: extra.index_current ?? wiki?.index_current,
    sha: extra.index_commit || wiki?.source_sha,
  };
}

function admissionExtra(evidence: VerificationEvidence): AdmissionProofExtra {
  return (evidence.admission ?? {}) as AdmissionProofExtra;
}

export function renderGitHubProof(
  evidence: VerificationEvidence,
  extras?: { linear?: string; linearUrl?: string },
): string {
  const extra = admissionExtra(evidence);
  const index = gitnexusIndexLine(extra, evidence.wiki);
  const admission = evidence.admission
    ? [
        '### Code admission',
        index.current === undefined
          ? ''
          : `GitNexus index: ${index.current ? 'current' : 'stale'}${index.sha ? ` at \`${index.sha.slice(0, 7)}\`` : ''}`,
        evidence.branch ? `Worktree: \`${evidence.branch}\`` : '',
        extra.existing_candidates === undefined
          ? ''
          : `Existing code candidates inspected: ${extra.existing_candidates}`,
        extra.reused_symbols === undefined
          ? ''
          : `Existing symbols reused: ${extra.reused_symbols.length}`,
        extra.modified_existing_symbols === undefined
          ? ''
          : `Existing symbols modified: ${extra.modified_existing_symbols.length}`,
        extra.impact_risk ? `Blast radius: ${extra.impact_risk.toUpperCase()}` : '',
        extra.approved_new_files || extra.actual_new_files
          ? `New files: approved ${extra.approved_new_files?.length ?? 0} / actual ${extra.actual_new_files?.length ?? 0}`
          : '',
        extra.approved_new_symbols || extra.actual_new_symbols
          ? `New symbols: approved ${extra.approved_new_symbols?.length ?? 0} / actual ${extra.actual_new_symbols?.length ?? 0}`
          : '',
        extra.approved_dependencies || extra.actual_new_dependencies
          ? `New dependencies: approved ${extra.approved_dependencies?.length ?? 0} / actual ${extra.actual_new_dependencies?.length ?? 0}`
          : '',
        extra.affected_processes?.length
          ? `Affected execution flows: ${extra.affected_processes.join(', ')}`
          : '',
        `Files changed: ${evidence.files_changed.length}`,
        `Admission violations: **${evidence.admission.violations.length}**`,
        evidence.admission.incomplete ? 'Incomplete audit (fail-closed).' : '',
        ...evidence.admission.violations.map((item) => `- ${item}`),
        `Result: ${evidence.admission.passed && !evidence.admission.incomplete ? 'PASS' : 'FAIL'}`,
      ].filter(Boolean)
    : [];

  return [
    '## ORCH verification proof',
    evidence.verified ? '**Verified**' : '**Not verified**',
    extras?.linear ? `Linear: ${extras.linear}` : '',
    extras?.linearUrl ? `Linear issue: ${extras.linearUrl}` : '',
    evidence.plan_id ? `Plan: \`${evidence.plan_id}\`` : '',
    evidence.plan_unit_id ? `Plan unit: \`${evidence.plan_unit_id}\`` : '',
    evidence.council_ref ? `Council: \`${evidence.council_ref}\`` : '',
    evidence.head_sha ? `HEAD: \`${evidence.head_sha}\`` : 'HEAD: missing (invalidates Verified)',
    evidence.branch ? `Branch: \`${evidence.branch}\`` : '',
    '',
    '### Checks',
    ...evidence.checks.map((check) => {
      const exit = check.exit_code === undefined ? '' : ` (exit ${check.exit_code})`;
      return `- ${check.name}: ${check.status}${exit}`;
    }),
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
    '### Changed files',
    ...evidence.files_changed.slice(0, 20).map((file) => `- ${file}`),
    evidence.files_changed.length === 0 ? '- none recorded' : '',
    '',
    evidence.learning_refs?.length ? '### Learnings' : '',
    ...(evidence.learning_refs ?? []).map((ref) => `- ${ref}`),
    '',
    ...admission,
    '',
    ...renderWikiProof(evidence),
  ].filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n');
}

function renderWikiProof(evidence: VerificationEvidence): string[] {
  if (!evidence.wiki) return [];
  const wiki = evidence.wiki;
  const lines = ['### Wiki'];
  if (wiki.status === 'bootstrap_required') {
    lines.push('GitNexus wiki preview: generated locally');
    if (wiki.provider) lines.push(`Canonical provider: ${wiki.provider === 'github' ? 'GitHub' : 'GitLab'}`);
    lines.push('Remote publication: one-time wiki bootstrap required');
  } else if (wiki.mode === 'canonical-publish') {
    lines.push(`Canonical wiki: ${wiki.status === 'passed' ? 'updated' : wiki.status}`);
    if (wiki.provider) lines.push(`Provider: ${wiki.provider === 'github' ? 'GitHub' : 'GitLab'}`);
  } else {
    lines.push(`GitNexus wiki preview: ${wiki.status === 'passed' ? 'generated' : wiki.status}`);
  }
  if (wiki.source_sha) lines.push(`Source SHA: \`${wiki.source_sha.slice(0, 7)}\``);
  if (wiki.pages_generated !== undefined) lines.push(`Generated pages: ${wiki.pages_generated}`);
  if (wiki.pages_published !== undefined) lines.push(`Pages published: ${wiki.pages_published}`);
  lines.push(`Failed modules: ${wiki.failed_modules?.length ?? 0}`);
  if (wiki.mode === 'pr-preview' || wiki.mode === 'local-preview') {
    lines.push('Canonical wiki modified: no — preview only');
  }
  if (wiki.artifact_url) lines.push(`Preview artifact: ${wiki.artifact_url}`);
  if (wiki.canonical_wiki_url) lines.push(`Wiki: ${wiki.canonical_wiki_url}`);
  if (wiki.summary) lines.push(wiki.summary);
  return lines;
}

export function renderLinearProof(evidence: VerificationEvidence): string {
  const extra = admissionExtra(evidence);
  const index = gitnexusIndexLine(extra, evidence.wiki);
  return [
    'ORCH proof',
    `Task: ${evidence.task_id}`,
    `Verified: ${evidence.verified ? 'yes' : 'no'}`,
    evidence.head_sha ? `SHA: ${evidence.head_sha}` : 'SHA: missing',
    evidence.plan_id ? `Plan: ${evidence.plan_id}` : '',
    evidence.plan_unit_id ? `Unit: ${evidence.plan_unit_id}` : '',
    evidence.council_ref ? `Council: ${evidence.council_ref}` : '',
    ...evidence.checks.map((check) => {
      const exit = check.exit_code === undefined ? '' : ` exit ${check.exit_code}`;
      return `Check: ${check.name} ${check.status}${exit}`;
    }),
    '',
    '### Architecture / reuse verification',
    index.current === undefined
      ? ''
      : `- GitNexus index current: ${index.current ? 'yes' : 'no'}`,
    extra.existing_candidates === undefined
      ? ''
      : `- Existing candidates inspected: ${extra.existing_candidates}`,
    extra.reused_symbols === undefined
      ? ''
      : `- Existing symbols reused: ${extra.reused_symbols.length}`,
    extra.modified_existing_symbols === undefined
      ? ''
      : `- Existing symbols modified: ${extra.modified_existing_symbols.length}`,
    extra.impact_risk
      ? `- Blast radius: ${extra.impact_risk.toUpperCase()}`
      : extra.affected_processes?.length
        ? `- Blast radius: ${extra.affected_processes.join(', ')}`
        : '',
    extra.impact_risk && extra.affected_processes?.length
      ? `- Affected flows: ${extra.affected_processes.join(', ')}`
      : '',
    extra.approved_new_files || extra.actual_new_files
      ? `- New files approved/actual: ${extra.approved_new_files?.length ?? 0} / ${extra.actual_new_files?.length ?? 0}`
      : '',
    extra.approved_new_symbols || extra.actual_new_symbols
      ? `- New symbols approved/actual: ${extra.approved_new_symbols?.length ?? 0} / ${extra.actual_new_symbols?.length ?? 0}`
      : '',
    extra.approved_dependencies || extra.actual_new_dependencies
      ? `- New dependencies approved/actual: ${extra.approved_dependencies?.length ?? 0} / ${extra.actual_new_dependencies?.length ?? 0}`
      : '',
    extra.affected_processes?.length
      ? `- Blast radius: ${extra.affected_processes.join(', ')}`
      : '',
    evidence.admission
      ? `- Admission: ${evidence.admission.passed && !evidence.admission.incomplete ? 'PASS' : 'FAIL'}`
      : '',
    `- Files changed: ${evidence.files_changed.length}`,
    evidence.admission
      ? `- Admission violations: ${evidence.admission.violations.length}`
      : '',
    ...(evidence.admission?.violations ?? []).map((item) => ` - ${item}`),
    evidence.pr_url ? `- GitHub proof: ${evidence.pr_url}` : '',
    evidence.wiki
      ? `- Wiki: ${evidence.wiki.status}${evidence.wiki.pages_generated !== undefined ? ` (${evidence.wiki.pages_generated} pages)` : ''}`
      : '',
    evidence.wiki?.canonical_wiki_url ? `- Wiki URL: ${evidence.wiki.canonical_wiki_url}` : '',
  ].filter(Boolean).join('\n');
}
