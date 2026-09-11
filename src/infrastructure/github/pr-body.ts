/**
 * GitHub PR body helpers — Linear magic-word + ORCH task/plan refs.
 */

import type { Task } from '../../domain/task.js';

export function linearMagicWords(
  identifier?: string | string[],
  kind: 'fixes' | 'contributes' = 'fixes',
): string {
  const ids = (Array.isArray(identifier) ? identifier : identifier ? [identifier] : [])
    .map((id) => id.trim())
    .filter(Boolean);
  const unique = [...new Set(ids)];
  if (unique.length === 0) return '';
  const joined = unique.join(', ');
  return kind === 'contributes' ? `Contributes to ${joined}` : `Fixes ${joined}`;
}

export function buildPrBody(task: Task, opts?: {
  completesIssue?: boolean;
  relatedIssues?: Array<{ identifier: string; url?: string; completes?: boolean }>;
}): string {
  const linear = task.external?.linear?.identifier;
  const kind = task.plan_unit_id && opts?.completesIssue !== true ? 'contributes' : 'fixes';
  const seen = new Set<string>();
  const fixes: string[] = [];
  const contributes: string[] = [];
  const add = (id: string | undefined, completes: boolean): void => {
    const trimmed = id?.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    (completes ? fixes : contributes).push(trimmed);
  };
  add(linear, kind === 'fixes');
  for (const item of opts?.relatedIssues ?? []) {
    add(item.identifier, item.completes === true);
  }
  const magic = [
    linearMagicWords(fixes, 'fixes'),
    linearMagicWords(contributes, 'contributes'),
  ].filter(Boolean).join('\n');
  const urls = [
    task.external?.linear?.url,
    ...(opts?.relatedIssues ?? []).map((item) => item.url),
  ].filter((url, index, all): url is string => Boolean(url) && all.indexOf(url) === index);
  const acceptance = (task.acceptance_criteria ?? []).map((item) => `- [ ] ${item}`);
  return [
    '## Summary',
    '',
    task.description || task.title,
    '',
    '## Linear',
    magic || '<!-- Fixes ENG-123  or  Contributes to ENG-123 -->',
    ...urls.map((url) => `Linear issue: ${url}`),
    '',
    '## ORCH',
    `Task: \`${task.id}\``,
    task.assignee ? `Agent: \`${task.assignee}\`` : '',
    task.plan_id ? `Plan: \`${task.plan_id}\`` : '',
    task.plan_unit_id ? `Plan unit: \`${task.plan_unit_id}\`` : '',
    task.council_ref ? `Council: \`${task.council_ref}\`` : '',
    '',
    '## Verification',
    '- [ ] Tests',
    '- [ ] Typecheck',
    '- [ ] Lint',
    ...acceptance,
    '- [ ] Required review completed',
    '',
    `<!-- orch-proof:${task.id}:${task.proof?.head_sha || 'HEADSHA'} -->`,
    '',
  ].filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n');
}

export function branchHint(task: Task): string {
  const linear = task.external?.linear?.identifier;
  const slug = task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return linear ? `orch/${linear}-${slug}` : `orch/${task.id}-${slug}`;
}
