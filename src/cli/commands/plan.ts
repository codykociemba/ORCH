/**
 * `orch plan` — route / validate a CE plan manifest (ORCH remains the scheduler).
 */

import type { Command } from 'commander';
import type { LightContainer } from '../../container.js';
import { printError, printKeyValue } from '../output.js';
import { buildPlanManifest, describeRoute, draftUnitsFromRequest } from '../../application/plan-router.js';
import { smallPlanImportBlocked, verifySmallPlanReuse, verifySmallPlanWithCodex } from '../../application/plan-reuse-verifier.js';
import { planAllowsReuseCreates, type PlanManifest, type PlanUnit, type ReuseAnalysis } from '../../domain/plan.js';
import { councilVerdictAllowsDispatch } from '../../domain/council.js';
import { atomicWrite, readJson, writeJson } from '../../infrastructure/storage/fs-utils.js';
import { ReuseAnalysisService } from '../../application/reuse-analysis-service.js';
import { GitNexusCodeIntelligence } from '../../infrastructure/code-intelligence/gitnexus-adapter.js';
import { McpStdioClient, defaultGitNexusMcpArgs } from '../../infrastructure/code-intelligence/mcp-stdio-client.js';

function collectUnit(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function registerPlanCommand(program: Command, container: LightContainer): void {
  const plan = program
    .command('plan')
    .description('Draft, validate, and route a Compound Engineering plan (ORCH stays the scheduler)')
    .argument('[request...]', 'Preferred entry: draft a plan from this goal (does not dispatch)')
    .option('--unit <title>', 'Additional plan unit (repeatable)', collectUnit, [] as string[])
    .option('--out <file>', 'Write the manifest JSON')
    .action(async (request: string[], opts: { unit?: string[]; out?: string }) => {
      if (request.length === 0) {
        printError('Usage: orch plan "<goal>"  or  orch plan draft|validate|import|reuse|verify|council');
        process.exitCode = 1;
        return;
      }
      await draftPlan(container, request.join(' '), opts.unit ?? [], opts.out);
    });

  plan
    .command('draft <request...>')
    .description('Draft a plan manifest from a goal/request (does not dispatch workers)')
    .option('--unit <title>', 'Additional plan unit (repeatable)', collectUnit, [] as string[])
    .option('--out <file>', 'Write the manifest JSON')
    .action(async (request: string[], opts: { unit?: string[]; out?: string }) => {
      await draftPlan(container, request.join(' '), opts.unit ?? [], opts.out);
    });

  plan
    .command('validate <file>')
    .description('Validate a plan JSON and print the routing decision')
    .action(async (file: string) => {
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
      const reuseCheck = verifySmallPlanReuse(manifest);
      container.eventBus.emit({ type: 'planning:validated', planId: manifest.id, ok: reuseCheck.ok });
      const { listLearnings, renderLearningContext } = await import('../../application/learning-reader.js');
      const learnings = renderLearningContext(await listLearnings(container.context.projectRoot));
      if (!reuseCheck.ok) process.exitCode = 1;
      if (container.context.json) {
        console.log(JSON.stringify({ manifest, reuse: reuseCheck }, null, 2));
        return;
      }
      printKeyValue([
        ['Digest', manifest.digest],
        ['Units', String(manifest.units.length)],
        ['Route', manifest.route],
        ['Council', manifest.council_required ? 'required' : 'no'],
        ['Reuse', reuseCheck.ok ? 'ok' : 'blocked'],
      ]);
      console.log(`  ${describeRoute(manifest)}`);
      for (const note of reuseCheck.notes) {
        console.log(`  ${note}`);
      }
      if (manifest.units.length <= 2) {
        console.log('  Import blocked until: orch plan verify <file>');
        for (const question of reuseCheck.questions) {
          console.log(`  Codex: ${question}`);
        }
      }
      if (learnings) console.log(learnings);
    });

  plan
    .command('reuse <queries...>')
    .description('Run GitNexus reuse analysis (suggestions only — does not authorize creates)')
    .action(async (queries: string[]) => {
      const spec = defaultGitNexusMcpArgs();
      const intelligence = new GitNexusCodeIntelligence({
        projectRoot: container.context.projectRoot,
        mcp: new McpStdioClient(spec.command, spec.args, container.context.projectRoot),
      });
      const analysis = await new ReuseAnalysisService(intelligence, container.context.projectRoot).analyze({ queries });
      if (container.context.json) {
        console.log(JSON.stringify(analysis, null, 2));
        return;
      }
      printKeyValue([
        ['Incomplete', analysis.incomplete ? 'yes' : 'no'],
        ['Candidates', String(analysis.candidates.length)],
        ['Creates (suggested)', String(analysis.proposed_creates.length)],
      ]);
      for (const hit of analysis.candidates) {
        console.log(`  edit  ${hit.path}${hit.symbol ? `#${hit.symbol}` : ''}`);
      }
      for (const create of analysis.proposed_creates) {
        console.log(`  create  ${create.name ?? create.path}  (${create.why_not_reuse})`);
      }
    });

  plan
    .command('verify <file>')
    .description('Codex reuse check for 1–2 unit plans (fail-closed if Codex is missing)')
    .action(async (file: string) => {
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
      const [{ ProcessManager }, { CodexAdapter }] = await Promise.all([
        import('../../infrastructure/process/process-manager.js'),
        import('../../infrastructure/adapters/codex.js'),
      ]);
      const adapter = new CodexAdapter(new ProcessManager({ foreground: true }));
      const verdict = await verifySmallPlanWithCodex(manifest, adapter, container.context.projectRoot);
      await writeJson(file, { ...raw, id: manifest.id, codex_verified: verdict.ok });
      await writeJson(container.paths.planManifestPath(manifest.id), { ...manifest, codex_verified: verdict.ok });
      if (!verdict.ok) process.exitCode = 1;
      if (container.context.json) {
        console.log(JSON.stringify(verdict, null, 2));
        return;
      }
      printKeyValue([
        ['Reuse', verdict.ok ? 'ok' : 'blocked'],
        ['Notes', String(verdict.notes.length)],
      ]);
      for (const note of verdict.notes) console.log(`  ${note}`);
    });

  plan
    .command('import <file>')
    .description('Create ORCH tasks from a plan manifest (ORCH stays the scheduler)')
    .action(async (file: string) => {
      const raw = await readJson<{
        id?: string;
        title?: string;
        goal_id?: string;
        units?: PlanUnit[];
        reuse?: ReuseAnalysis;
        council_ref?: string;
        codex_verified?: boolean;
      }>(file);
      if (!raw?.title || !raw.units) {
        printError('Plan file must include title and units[]');
        process.exitCode = 1;
        return;
      }
      if (smallPlanImportBlocked(raw.units.length, raw.codex_verified)) {
        printError('1–2 unit plans require `orch plan verify` (Codex) before import');
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
      await writeJson(container.paths.planManifestPath(manifest.id), manifest);
      const councilId = raw.council_ref ?? manifest.council_ref;
      const { CouncilStore } = await import('../../infrastructure/storage/council-store.js');
      const storedCouncil = councilId ? await new CouncilStore(container.paths).get(councilId) : null;
      const allowCreates = planAllowsReuseCreates(manifest.council_required, storedCouncil?.verdict);
      const created: Array<{ unitId: string; taskId: string }> = [];
      const byUnit = new Map<string, string>();
      for (const unit of manifest.units) {
        const labels = [...(unit.labels ?? [])];
        if (manifest.council_required) labels.push('council-required');
        const depends_on = unit.depends_on
          .map((unitId) => byUnit.get(unitId))
          .filter((id): id is string => !!id);
        const task = await container.taskService.create({
          title: unit.title,
          description: unit.description,
          labels,
          depends_on,
          goalId: manifest.goal_id,
          plan_id: manifest.id,
          plan_unit_id: unit.id,
          council_ref: storedCouncil && councilVerdictAllowsDispatch(storedCouncil.verdict)
            ? storedCouncil.id
            : undefined,
          acceptance_criteria: unit.acceptance_criteria,
        });
        created.push({ unitId: unit.id, taskId: task.id });
        byUnit.set(unit.id, task.id);
        if (allowCreates && manifest.reuse.proposed_creates.length > 0) {
          await container.codeAdmissionService.applyReuseCreates(task, manifest.reuse);
        }
      }
      for (const unit of manifest.units) {
        const taskId = byUnit.get(unit.id);
        if (!taskId) continue;
        const task = await container.taskStore.get(taskId);
        if (!task) continue;
        task.depends_on = unit.depends_on
          .map((unitId) => byUnit.get(unitId))
          .filter((id): id is string => !!id);
        await container.taskStore.save(task);
      }
      if (container.context.json) {
        console.log(JSON.stringify({ manifest, created }, null, 2));
        return;
      }
      printKeyValue([
        ['Plan', manifest.id],
        ['Tasks', String(created.length)],
        ['Council', manifest.council_required ? (raw.council_ref ?? 'blocked until orch plan council') : 'no'],
        ...(container.workflowConfig?.linear?.enabled === true && !container.integrationService.enabled()
          ? [['Linear', 'login required — orch integration login']] as Array<[string, string]>
          : []),
      ]);
      for (const item of created) {
        console.log(`  ${item.unitId} → ${item.taskId}`);
      }
    });

  plan
    .command('council <planId> <councilId>')
    .description('Attach a council result to every task from a plan')
    .action(async (planId: string, councilId: string) => {
      const { CouncilStore } = await import('../../infrastructure/storage/council-store.js');
      const { councilVerdictAllowsDispatch } = await import('../../domain/council.js');
      const result = await new CouncilStore(container.paths).get(councilId);
      if (!result) {
        printError(`Council result not found: ${councilId}`);
        process.exitCode = 1;
        return;
      }
      if (!councilVerdictAllowsDispatch(result.verdict)) {
        printError(`Council ${councilId} is ${result.verdict} — not attaching (dispatch stays blocked)`);
        process.exitCode = 1;
        return;
      }
      const tasks = await container.taskStore.list();
      const matched = tasks.filter((task) => task.plan_id === planId);
      for (const task of matched) {
        task.council_ref = councilId;
        task.updated_at = new Date().toISOString();
        await container.taskStore.save(task);
      }
      await authorizeApprovedPlanCreates(container, planId);
      printKeyValue([
        ['Plan', planId],
        ['Council', councilId],
        ['Updated', String(matched.length)],
      ]);
    });
}

export async function authorizeApprovedPlanCreates(
  container: LightContainer,
  planId: string,
): Promise<number> {
  const manifest = await readJson<PlanManifest>(container.paths.planManifestPath(planId));
  if (!manifest?.reuse.proposed_creates.length) return 0;
  const tasks = (await container.taskStore.list()).filter((task) => task.plan_id === planId);
  for (const task of tasks) {
    await container.codeAdmissionService.applyReuseCreates(task, manifest.reuse);
  }
  return tasks.length;
}

async function draftPlan(
  container: LightContainer,
  title: string,
  extraUnits: string[],
  outFile?: string,
): Promise<void> {
  const spec = defaultGitNexusMcpArgs();
  const mcp = new McpStdioClient(spec.command, spec.args, container.context.projectRoot);
  const intelligence = new GitNexusCodeIntelligence({
    projectRoot: container.context.projectRoot,
    mcp,
  });
  try {
    const units = stampTopicCouncilRisk(title, draftUnitsFromRequest(title, extraUnits));
    const queries = [
      title,
      ...units.map((unit) => unit.title),
      ...units.flatMap((unit) => unit.acceptance_criteria),
    ].filter((item, index, all) => item.trim().length > 0 && all.indexOf(item) === index);
    const reuse = await new ReuseAnalysisService(intelligence, container.context.projectRoot).analyze({
      queries,
    });
    if (reuse.candidates.length > 0) {
      for (const unit of units) {
        const targeted = reuse.candidates.filter((item) =>
          item.reason.includes(`"${unit.title}"`) || (item.symbol ?? '').toLowerCase() === unit.title.toLowerCase(),
        );
        const symbols = (targeted.length > 0 ? targeted : reuse.candidates)
          .filter((item) => item.kind !== 'process')
          .slice(0, 5);
        const processes = reuse.candidates.filter((item) => item.kind === 'process').slice(0, 5);
        if (symbols.length === 0 && processes.length === 0) continue;
        unit.description = [
          unit.description,
          symbols.length ? 'Existing code:' : '',
          ...symbols.map((item) => `- ${item.path}${item.symbol ? `#${item.symbol}` : ''} (${item.decision})`),
          processes.length ? 'Execution flows:' : '',
          ...processes.map((item) => `- ${item.symbol ?? item.path}`),
          symbols.some((item) => item.reason.includes('impact ')) ? 'Impact:' : '',
          ...symbols
            .filter((item) => item.reason.includes('impact '))
            .map((item) => `- ${item.symbol ?? item.path}: ${item.reason.slice(item.reason.indexOf('impact '))}`),
        ].filter(Boolean).join('\n');
      }
    }
    const { listLearnings, renderLearningContext } = await import('../../application/learning-reader.js');
    const notes = await listLearnings(container.context.projectRoot);
    container.eventBus.emit({ type: 'learning:refreshed', goalId: notes[0]?.goal_id });
    const learningBlock = renderLearningContext(notes);
    if (learningBlock && units[0]) {
      units[0].description = [units[0].description, learningBlock].filter(Boolean).join('\n\n');
    }
    const manifest = buildPlanManifest({
      id: `plan_${Date.now().toString(36)}`,
      title,
      units,
      reuse,
      workflow: container.workflowConfig,
    });
    container.eventBus.emit({ type: 'planning:started', planId: manifest.id, title: manifest.title });
    await writeJson(container.paths.planManifestPath(manifest.id), manifest);
    if (outFile) await atomicWrite(outFile, `${JSON.stringify(manifest, null, 2)}\n`);
    if (container.context.json) {
      console.log(JSON.stringify(manifest, null, 2));
      return;
    }
    printKeyValue([
      ['Plan', manifest.id],
      ['Units', String(manifest.units.length)],
      ['Route', manifest.route],
      ['Council', manifest.council_required ? 'required' : 'no'],
      ['Reuse hits', String(reuse.candidates.length)],
      ['Reuse', reuse.incomplete ? 'incomplete — do not authorize creates' : 'ok'],
    ]);
    const highImpact = reuse.candidates.filter((item) => /impact (HIGH|CRITICAL)/.test(item.reason));
    if (highImpact.length > 0) {
      console.log(`  HIGH/CRITICAL impact is not automatic reuse: ${highImpact.map((item) => item.symbol ?? item.path).join(', ')}`);
    }
    console.log(`  ${describeRoute(manifest)}`);
    if (outFile) console.log(`  wrote ${outFile}`);
    console.log('  Next: orch plan validate <file>  then  orch plan import <file>');
    if (manifest.council_required) console.log('  Council must approve before dispatch (orch council convene)');
    if (learningBlock) console.log(learningBlock);
  } finally {
    await mcp.close();
  }
}

/** Spec §5.1: 3–4 units require council for auth/payments/migrations/infra, not only explicit high risk. */
function stampTopicCouncilRisk(title: string, units: PlanUnit[]): PlanUnit[] {
  return units.map((unit) => {
    if (unit.risk === 'high' || unit.risk === 'critical' || unit.risk === 'unknown') return unit;
    const text = [title, unit.title, unit.description ?? '', ...(unit.labels ?? [])].join('\n');
    if (!TOPIC_COUNCIL.test(text)) return unit;
    return { ...unit, risk: 'high' };
  });
}

const TOPIC_COUNCIL = /\b(auth|oauth|security|payment|stripe|migrat|concurren|distributed|infra|deploy|destructive|api contract|multi-?service|external integration)\b/i;
