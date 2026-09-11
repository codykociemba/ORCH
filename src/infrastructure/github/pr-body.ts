/**
 * GitHub PR body helpers — Linear magic-word + ORCH task/plan refs.
 */

import type { Task } from '../../domain/task.js';

export function linearMagicWords(identifier?: string): string {
  if (!identifier) return '';
  return `Fixes ${identifier}`;
}

export function buildPrBody(task: Task): string {
  const linear = task.external?.linear?.identifier;
  const magic = linearMagicWords(linear);
  return [
    magic,
    '',
    `ORCH task: \`${task.id}\``,
    task.plan_unit_id ? `Plan unit: \`${task.plan_unit_id}\`` : '',
    task.plan_id ? `Plan: \`${task.plan_id}\`` : '',
    task.council_ref ? `Council: \`${task.council_ref}\`` : '',
    '',
    task.description,
  ].filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n');
}

export function branchHint(task: Task): string {
  const linear = task.external?.linear?.identifier;
  const slug = task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return linear ? `orch/${linear}-${slug}` : `orch/${task.id}-${slug}`;
}
