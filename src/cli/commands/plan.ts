/**
 * `orch plan` — route / validate a CE plan manifest (ORCH remains the scheduler).
 */

import type { Command } from 'commander';
import type { LightContainer } from '../../container.js';
import { printError, printKeyValue } from '../output.js';
import { buildPlanManifest, describeRoute, draftUnitsFromRequest } from '../../application/plan-router.js';
import { verifySmallPlanReuse, verifySmallPlanWithCodex } from '../../application/plan-reuse-verifier.js';
import type { PlanUnit, ReuseAnalysis } from '../../domain/plan.js';
import { atomicWrite, readJson } from '../../infrastructure/storage/fs-utils.js';
import { ReuseAnalysisService } from '../../application/reuse-analysis-service.js';
import { GitNexusCodeIntelligence } from '../../infrastructure/code-intelligence/gitnexus-adapter.js';
import { McpStdioClient, defaultGitNexusMcpArgs } from '../../infrastructure/code-intelligence/mcp-stdio-client.js';

function collectUnit(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function registerPlanCommand(program: Command, container: LightContainer): void {
  const plan = program
    .command('plan')
    .description('Draft, validate, and route a Compound Engineering plan (ORCH stays the scheduler)');

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
        units: raw.units,
        reuse: raw.reuse ?? emptyReuse,
        workflow: container.workflowConfig,
      });
      const reuseCheck = verifySmallPlanReuse(manifest);
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
        units: raw.units,
        reuse: raw.reuse ?? emptyReuse,
        workflow: container.workflowConfig,
      });
      const [{ ProcessManager }, { CodexAdapter }] = await Promise.all([
        import('../../infrastructure/process/process-manager.js'),
        import('../../infrastructure/adapters/codex.js'),
      ]);
      const adapter = new CodexAdapter(new ProcessManager({ foreground: true }));
      const verdict = await verifySmallPlanWithCodex(manifest, adapter, container.context.projectRoot);
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
        units: raw.units,
        reuse: raw.reuse ?? emptyReuse,
        workflow: container.workflowConfig,
      });
      const created: Array<{ unitId: string; taskId: string }> = [];
      for (const unit of manifest.units) {
        const labels = [...(unit.labels ?? [])];
        if (manifest.council_required) labels.push('council-required');
        const task = await container.taskService.create({
          title: unit.title,
          description: unit.description,
          labels,
          goalId: manifest.goal_id,
          plan_id: manifest.id,
          plan_unit_id: unit.id,
          council_ref: raw.council_ref ?? manifest.council_ref,
          acceptance_criteria: unit.acceptance_criteria,
        });
        created.push({ unitId: unit.id, taskId: task.id });
        if (manifest.reuse.proposed_creates.length > 0) {
          await container.codeAdmissionService.applyReuseCreates(task, manifest.reuse);
        }
      }
      const byUnit = new Map(created.map((item) => [item.unitId, item.taskId]));
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
      ]);
      for (const item of created) {
        console.log(`  ${item.unitId} → ${item.taskId}`);
      }
    });

  plan
    .command('council <planId> <councilId>')
    .description('Attach a council result to every task from a plan')
    .action(async (planId: string, councilId: string) => {
      const tasks = await container.taskStore.list();
      const matched = tasks.filter((task) => task.plan_id === planId);
      for (const task of matched) {
        task.council_ref = councilId;
        task.updated_at = new Date().toISOString();
        await container.taskStore.save(task);
      }
      printKeyValue([
        ['Plan', planId],
        ['Council', councilId],
        ['Updated', String(matched.length)],
      ]);
    });
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
    const reuse = await new ReuseAnalysisService(intelligence, container.context.projectRoot).analyze({
      queries: [title],
    });
    const units = draftUnitsFromRequest(title, extraUnits);
    const manifest = buildPlanManifest({
      id: `plan_${Date.now().toString(36)}`,
      title,
      units,
      reuse,
      workflow: container.workflowConfig,
    });
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
    ]);
    console.log(`  ${describeRoute(manifest)}`);
    if (outFile) console.log(`  wrote ${outFile}`);
    console.log('  Next: orch plan validate <file>  then  orch plan import <file>');
    if (manifest.council_required) console.log('  Council must approve before dispatch (orch council convene)');
  } finally {
    await mcp.close();
  }
}
