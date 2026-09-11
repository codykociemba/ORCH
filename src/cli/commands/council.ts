/**
 * `orch council` — persist and inspect multi-model council artifacts.
 */

import type { Command } from 'commander';
import type { LightContainer } from '../../container.js';
import { printError, printKeyValue, printSuccess } from '../output.js';
import { CouncilStore } from '../../infrastructure/storage/council-store.js';
import { readJson } from '../../infrastructure/storage/fs-utils.js';
import type { CouncilResult, CouncilVerdict } from '../../domain/council.js';
import { buildPlanManifest } from '../../application/plan-router.js';
import type { PlanUnit, ReuseAnalysis } from '../../domain/plan.js';

export function registerCouncilCommand(program: Command, container: LightContainer): void {
  const council = program
    .command('council')
    .description('Record independent multi-model plan review (does not schedule work)');

  const store = new CouncilStore(container.paths);

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
      if (result.plan_id) {
        const tasks = await container.taskStore.list();
        for (const task of tasks.filter((item) => item.plan_id === result.plan_id)) {
          task.council_ref = result.id;
          task.updated_at = new Date().toISOString();
          await container.taskStore.save(task);
        }
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
      ]);
      for (const vote of result.votes) {
        console.log(`  ${vote.adapter}/${vote.model}  ${vote.verdict}  ${vote.summary}`);
      }
    });

  council
    .command('convene <file>')
    .description('Run independent Claude + Codex + Cursor (Grok 4.6) review of a plan (does not dispatch)')
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
      const service = new CouncilService(store, (kind) => registry.get(kind), container.context.projectRoot);
      const result = await service.convene({ plan: manifest });
      if (result.plan_id) {
        const tasks = await container.taskStore.list();
        for (const task of tasks.filter((item) => item.plan_id === result.plan_id)) {
          if (result.verdict === 'approve') {
            task.council_ref = result.id;
            task.updated_at = new Date().toISOString();
            await container.taskStore.save(task);
          }
        }
      }
      if (container.context.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printSuccess(`${result.id} ${result.verdict}`);
      for (const vote of result.votes) {
        console.log(`  ${vote.adapter}  ${vote.verdict}  ${vote.summary}`);
      }
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
