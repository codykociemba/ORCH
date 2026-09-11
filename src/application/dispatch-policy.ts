/**
 * Watcher-owned dispatch gates. Workers never bypass these.
 */

import type { Task } from '../domain/task.js';
import { COUNCIL_OVERRIDE_LABEL } from '../domain/council.js';

export interface DispatchGateOptions {
  linearRequired: boolean;
  requirePlan: boolean;
}

export function passesDispatchGates(task: Task, opts: DispatchGateOptions): boolean {
  if (opts.linearRequired && !task.external?.linear?.id) return false;
  if (
    task.labels.includes('council-required')
    && !task.council_ref
    && !task.labels.includes(COUNCIL_OVERRIDE_LABEL)
  ) {
    return false;
  }
  if (opts.requirePlan && !!task.goalId && !task.plan_id) return false;
  return true;
}
