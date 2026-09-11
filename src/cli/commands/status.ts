/**
 * `orch status` command.
 *
 * One-shot overview: tasks by status, running tasks, metrics.
 */

import type { Command } from 'commander';
import type { LightContainer } from '../../container.js';
import { COUNCIL_OVERRIDE_LABEL } from '../../domain/council.js';
import {
  statusIcon,
  priorityLabel,
  formatDurationSince,
  formatTokens,
  amber,
  dim,
  agentName,
} from '../output.js';

export function registerStatusCommand(program: Command, container: LightContainer): void {
  program
    .command('status')
    .description('Show orchestrator status')
    .action(async () => {


      const tasks = await container.taskService.list();
      const agents = await container.agentService.list();
      const state = await container.stateStore.read();

      if (container.context.json) {
        console.log(JSON.stringify({ tasks, agents, state }, null, 2));
        return;
      }

      // Header
      const runningCount = Object.keys(state.running).length;
      const mode = state.pid ? 'watching' : 'idle';
      const uptime = state.started_at ? formatDurationSince(state.started_at) : '';

      console.log();
      console.log(`${amber('orch')} · ${container.config.project.name} · ${mode}`);
      const admissionOn = container.workflowConfig?.code_admission?.enabled === true;
      const linearOn = container.workflowConfig?.linear?.enabled === true;
      const linearReady = container.integrationService.enabled();
      console.log(`  ${dim('workflow')}    admission ${admissionOn ? 'on' : 'off'}  linear ${linearOn ? (linearReady ? 'ready' : 'login required') : 'off'}`);
      console.log();

      // Status counts
      const counts: Record<string, number> = {};
      for (const t of tasks) {
        counts[t.status] = (counts[t.status] ?? 0) + 1;
      }

      if (runningCount > 0) {
        console.log(`  ${'RUNNING'.padEnd(12)}${runningCount}${''.padEnd(20)}AGENTS  ${agents.length}`);
      }
      for (const [status, count] of Object.entries(counts)) {
        if (status !== 'in_progress') {
          console.log(`  ${dim(status.padEnd(12))}${count}`);
        }
      }

      // Running tasks
      const runningTasks = tasks.filter((t) => t.status === 'in_progress');
      if (runningTasks.length > 0) {
        console.log();
        for (const t of runningTasks) {
          const time = formatDurationSince(t.updated_at);
          console.log(
            `  ${statusIcon('in_progress')} ${t.assignee ? agentName(t.assignee) : ''}  ${t.title.slice(0, 35).padEnd(37)}${time}  ${priorityLabel(t.priority)}`,
          );
        }
      }

      const workflowTasks = tasks.filter((task) =>
        task.external?.linear
        || task.external?.github
        || task.proof?.head_sha
        || task.council_ref
        || task.labels.includes(COUNCIL_OVERRIDE_LABEL)
        || (task.reviews?.length ?? 0) > 0
        || task.status === 'in_progress'
        || task.status === 'review',
      );
      if (workflowTasks.length > 0) {
        console.log();
        for (const task of workflowTasks) {
          const contract = admissionOn
            ? await container.codeAdmissionService.getContract(task.id)
            : null;
          const requests = admissionOn
            ? await container.codeAdmissionService.listRequests(task.id)
            : [];
          const latestRequest = requests[requests.length - 1];
          const bits = [
            task.external?.linear?.identifier,
            task.external?.github?.pr_url,
            task.proof?.verified
              ? `proof verified @ ${(task.proof.head_sha ?? '').slice(0, 7)}`
              : task.proof?.head_sha
                ? `proof pending @ ${task.proof.head_sha.slice(0, 7)}`
                : null,
            task.reviews?.length
              ? `review ${task.reviews[task.reviews.length - 1]!.verdict}`
              : null,
            task.council_ref,
            task.labels.includes(COUNCIL_OVERRIDE_LABEL) ? COUNCIL_OVERRIDE_LABEL : null,
            contract
              ? `admission ${contract.code_index.index_current ? 'current' : 'stale'} ${contract.allowed_new_files.length}f/${contract.allowed_new_symbols.length}s/${contract.allowed_dependencies.length}d`
              : null,
            latestRequest ? `adm ${latestRequest.id} ${latestRequest.status}` : null,
          ].filter(Boolean);
          if (bits.length > 0) {
            console.log(`  ${dim(task.id.padEnd(12))}${bits.join('  ')}`);
          }
        }
      }

      // Footer
      const tt = state.stats.total_tokens;
      const tokenParts: string[] = [];
      if (tt.total > 0) {
        tokenParts.push(`\u2191${formatTokens(tt.input)}`);
        tokenParts.push(`\u2193${formatTokens(tt.output)}`);
        if (tt.reasoning > 0) tokenParts.push(`\u{1F9E0}${formatTokens(tt.reasoning)}`);
        tokenParts.push(`\u03A3${formatTokens(tt.total)}`);
      }
      const footer = [
        uptime ? `up ${uptime}` : null,
        tokenParts.length > 0 ? tokenParts.join(' ') : null,
      ]
        .filter(Boolean)
        .join(' · ');

      if (footer) {
        console.log();
        console.log(`  ${dim(footer)}`);
      }

      console.log();
    });
}
