/**
 * `orch council` — persist and inspect multi-model council artifacts.
 */

import type { Command } from 'commander';
import type { LightContainer } from '../../container.js';
import { printError, printKeyValue, printSuccess } from '../output.js';
import { CouncilStore } from '../../infrastructure/storage/council-store.js';
import { readJson, writeJson } from '../../infrastructure/storage/fs-utils.js';
import {
  COUNCIL_OVERRIDE_LABEL,
  councilVerdictAllowsDispatch,
  type CouncilResult,
  type CouncilVerdict,
} from '../../domain/council.js';
import { buildPlanManifest } from '../../application/plan-router.js';
import { authorizeApprovedPlanCreates } from './plan.js';
import type { PlanUnit, ReuseAnalysis } from '../../domain/plan.js';

export function registerCouncilCommand(program: Command, container: LightContainer): void {
  const store = new CouncilStore(container.paths);
  const council = program
    .command('council')
    .description('Record independent multi-model plan review (does not schedule work)')
    .argument('[file]', 'Preferred entry: convene review of a plan JSON')
    .action(async (file?: string) => {
      if (!file) return;
      await convenePlanFile(container, store, file);
    });

  council
    .command('save <file>')
    .description('Save a council result JSON and optionally attach it to a plan')
    .option('--plan <planId>', 'Attach this result to all tasks with that plan_id')
    .action(async (file: string, opts: { plan?: string }) => {
      const raw = await readJson<Partial<CouncilResult>>(file);
      if (!raw?.verdict || !raw.votes?.length) {
        printError('Council file must include verdict and votes[]');
        process.exitCode = 1;
        return;
      }
      const result: CouncilResult = {
        id: raw.id ?? store.createId(),
        plan_id: opts.plan ?? raw.plan_id,
        admission_request_id: raw.admission_request_id,
        created_at: raw.created_at ?? new Date().toISOString(),
        rounds: raw.rounds ?? 1,
        votes: raw.votes,
        verdict: raw.verdict as CouncilVerdict,
        summary: raw.summary ?? '',
        gitnexus_evidence: raw.gitnexus_evidence,
      };
      await store.save(result);
      if (result.plan_id && councilVerdictAllowsDispatch(result.verdict)) {
        const tasks = await container.taskStore.list();
        for (const task of tasks.filter((item) => item.plan_id === result.plan_id)) {
          task.council_ref = result.id;
          task.updated_at = new Date().toISOString();
          await container.taskStore.save(task);
        }
        await authorizeApprovedPlanCreates(container, result.plan_id);
      }
      printSuccess(`${result.id} ${result.verdict}`);
    });

  council
    .command('show <id>')
    .description('Show a saved council artifact')
    .action(async (id: string) => {
      const result = await store.get(id);
      if (!result) {
        printError(`Council result not found: ${id}`);
        process.exitCode = 1;
        return;
      }
      if (container.context.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printKeyValue([
        ['Id', result.id],
        ['Verdict', result.verdict],
        ['Rounds', String(result.rounds)],
        ['Votes', String(result.votes.length)],
        ['Plan', result.plan_id ?? '—'],
        ['Digest', result.plan_digest ?? '—'],
        ['Override', result.human_override ? result.human_override.reason : '—'],
      ]);
      for (const vote of result.votes) {
        console.log(`  ${vote.adapter}/${vote.model}  ${vote.verdict}  ${vote.summary}`);
      }
    });

  council
    .command('convene <file>')
    .description('Run independent Claude + Codex + Cursor (Grok 4.6) review of a plan (does not dispatch)')
    .action(async (file: string) => {
      await convenePlanFile(container, store, file);
    });

  council
    .command('override <planId>')
    .description('Human unlock for a council-required plan (does not fabricate an approve)')
    .requiredOption('--reason <text>', 'Why dispatch may proceed without council approve')
    .action(async (planId: string, opts: { reason: string }) => {
      const reason = opts.reason.trim();
      if (!reason) {
        printError('Override reason is required');
        process.exitCode = 1;
        return;
      }
      const tasks = await container.taskStore.list();
      const matched = tasks.filter((task) => task.plan_id === planId);
      if (matched.length === 0) {
        printError(`No tasks found for plan ${planId}`);
        process.exitCode = 1;
        return;
      }
      const at = new Date().toISOString();
      const override = {
        reason,
        at,
        actor: 'human' as const,
        task_ids: matched.map((task) => task.id),
      };
      for (const task of matched) {
        if (!task.labels.includes(COUNCIL_OVERRIDE_LABEL)) {
          task.labels = [...task.labels, COUNCIL_OVERRIDE_LABEL];
        }
        task.feedback = [`council override: ${reason}`, task.feedback].filter(Boolean).join('\n');
        task.updated_at = at;
        await container.taskStore.save(task);
      }
      const councilJson = container.paths.councilPlanJsonPath(planId);
      const existing = await readJson<CouncilResult>(councilJson);
      if (existing?.id && existing.votes) {
        existing.human_override = override;
        await store.save(existing);
      }
      await writeJson(councilJson.replace(/-council\.json$/i, '-council-override.json'), {
        plan_id: planId,
        ...override,
      });
      container.eventBus.emit({
        type: 'planning:council_overridden',
        planId,
        reason,
        taskCount: matched.length,
      });
      printSuccess(`${planId} override audited on ${matched.length} task(s)`);
    });

  council
    .command('list')
    .description('List saved council artifacts')
    .action(async () => {
      const results = await store.list();
      if (container.context.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }
      if (results.length === 0) {
        console.log('  No council artifacts');
        return;
      }
      for (const result of results) {
        console.log(`  ${result.id}  ${result.verdict.padEnd(8)}  ${result.plan_id ?? ''}  ${result.summary}`);
      }
    });
}

async function convenePlanFile(
  container: LightContainer,
  store: CouncilStore,
  file: string,
): Promise<void> {
  const raw = await readJson<{
    id?: string;
    title?: string;
    goal_id?: string;
    units?: PlanUnit[];
    reuse?: ReuseAnalysis;
  }>(file);
  if (!raw?.title || !raw.units) {
    printError('Plan file must include title and units[]');
    process.exitCode = 1;
    return;
  }
  const emptyReuse: ReuseAnalysis = {
    searches: [],
    candidates: [],
    recommended_edits: [],
    proposed_creates: [],
    incomplete: false,
    reasons: [],
  };
  const manifest = buildPlanManifest({
    id: raw.id ?? 'plan_local',
    title: raw.title,
    goalId: raw.goal_id,
    units: stampTopicCouncilRisk(raw.title, raw.units),
    reuse: raw.reuse ?? emptyReuse,
    workflow: container.workflowConfig,
  });
  const [
    { ProcessManager },
    { AdapterRegistry },
    { ClaudeAdapter },
    { CodexAdapter },
    { CursorAdapter },
    { CouncilService },
  ] = await Promise.all([
    import('../../infrastructure/process/process-manager.js'),
    import('../../infrastructure/adapters/registry.js'),
    import('../../infrastructure/adapters/claude.js'),
    import('../../infrastructure/adapters/codex.js'),
    import('../../infrastructure/adapters/cursor.js'),
    import('../../application/council-service.js'),
  ]);
  const pm = new ProcessManager({ foreground: true });
  const registry = new AdapterRegistry();
  registry.register(new ClaudeAdapter(pm));
  registry.register(new CodexAdapter(pm));
  registry.register(new CursorAdapter(pm));
  const service = new CouncilService(
    store,
    (kind) => registry.get(kind),
    container.context.projectRoot,
    180_000,
    container.eventBus,
  );
  await writeJson(container.paths.planManifestPath(manifest.id), manifest);
  const result = await service.convene({ plan: manifest });
  if (result.plan_id && councilVerdictAllowsDispatch(result.verdict)) {
    const tasks = await container.taskStore.list();
    for (const task of tasks.filter((item) => item.plan_id === result.plan_id)) {
      task.council_ref = result.id;
      task.updated_at = new Date().toISOString();
      await container.taskStore.save(task);
    }
    await authorizeApprovedPlanCreates(container, result.plan_id);
  }
  if (container.context.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printSuccess(`${result.id} ${result.verdict}`);
  for (const vote of result.votes) {
    console.log(`  ${vote.adapter}  ${vote.verdict}  ${vote.summary}`);
  }
}

function stampTopicCouncilRisk(title: string, units: PlanUnit[]): PlanUnit[] {
  return units.map((unit) => {
    if (unit.risk === 'high' || unit.risk === 'critical' || unit.risk === 'unknown') return unit;
    const text = [title, unit.title, unit.description ?? '', ...(unit.labels ?? [])].join('\n');
    if (!/\b(auth|oauth|security|payment|stripe|migrat|concurren|distributed|infra|deploy|destructive|api contract|multi-?service|external integration)\b/i.test(text)) {
      return unit;
    }
    return { ...unit, risk: 'high' };
  });
}
