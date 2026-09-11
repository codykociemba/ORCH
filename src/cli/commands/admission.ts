/**
 * `orch admission` — request / show / audit. Light container, no PID lock.
 */

import type { Command } from 'commander';
import type { LightContainer } from '../../container.js';
import { printError, printKeyValue, printSuccess, dim } from '../output.js';
import type { AdmissionRequestType } from '../../domain/admission.js';

export function registerAdmissionCommand(program: Command, container: LightContainer): void {
  const admission = program
    .command('admission')
    .description('Code admission requests and audits (watcher-owned decisions)')
    .hook('postAction', async () => {
      await container.codeIntelligence?.close?.();
    });

  admission
    .command('request')
    .description('Submit a create/scope request for the watcher to decide')
    .requiredOption('--task <id>', 'Task ID')
    .requiredOption('--type <type>', 'new_file|new_symbol|new_dependency|scope_expansion|high_risk_edit')
    .option('--path <path>', 'Proposed file path')
    .option('--name <name>', 'Proposed symbol name')
    .option('--package <name>', 'Proposed dependency')
    .option('--need <text>', 'Why this create is necessary')
    .option('--search <queries>', 'Comma-separated GitNexus searches already tried')
    .option('--why-not-reuse <text>', 'Why existing files/symbols are not enough')
    .action(async (opts: Record<string, string>) => {
      try {
        const request = await container.codeAdmissionService.submitRequest({
          task_id: opts['task'] ?? '',
          type: opts['type'] as AdmissionRequestType,
          proposed: {
            path: opts['path'],
            name: opts['name'],
            package: opts['package'],
          },
          need: opts['need'],
          gitnexus_searches: opts['search']?.split(',').map((item) => item.trim()).filter(Boolean),
          why_existing_file_is_not_enough: opts['whyNotReuse'],
        });
        if (container.context.json) {
          console.log(JSON.stringify(request, null, 2));
          return;
        }
        printSuccess(`${request.id} ${request.status}`);
        if (request.decision?.reason) console.log(`  ${dim(request.decision.reason)}`);
        if (request.decision?.redirect?.path) {
          console.log(`  reuse ${request.decision.redirect.path}`);
        }
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  admission
    .command('show <taskId>')
    .description('Show the modification contract for a task')
    .action(async (taskId: string) => {
      const contract = await container.codeAdmissionService.getContract(taskId);
      if (!contract) {
        printError(`No contract for ${taskId}`);
        process.exitCode = 1;
        return;
      }
      if (container.context.json) {
        console.log(JSON.stringify(contract, null, 2));
        return;
      }
      printKeyValue([
        ['Task', contract.task_id],
        ['Source', contract.source],
        ['Index', `${contract.code_index.repo} ${contract.code_index.index_current ? 'current' : 'stale'}`],
        ['New files', String(contract.allowed_new_files.length)],
        ['New symbols', String(contract.allowed_new_symbols.length)],
        ['Dependencies', String(contract.allowed_dependencies.length)],
      ]);
    });

  admission
    .command('requests [taskId]')
    .description('List admission requests')
    .action(async (taskId?: string) => {
      const requests = await container.codeAdmissionService.listRequests(taskId);
      if (container.context.json) {
        console.log(JSON.stringify(requests, null, 2));
        return;
      }
      if (requests.length === 0) {
        console.log(dim('  No admission requests'));
        return;
      }
      for (const request of requests) {
        const target = request.proposed.path ?? request.proposed.name ?? request.proposed.package ?? '';
        console.log(`  ${request.id}  ${request.type.padEnd(16)} ${request.status.padEnd(12)} ${target}`);
      }
    });

  admission
    .command('audit <taskId>')
    .description('Run the Git + GitNexus admission audit for a task')
    .action(async (taskId: string) => {
      const task = await container.taskStore.get(taskId);
      if (!task) {
        printError(`Task not found: ${taskId}`);
        process.exitCode = 1;
        return;
      }
      const result = await container.codeAdmissionService.auditTask(task);
      if (container.context.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      printKeyValue([
        ['Passed', result.passed ? 'yes' : 'no'],
        ['Incomplete', result.incomplete ? 'yes' : 'no'],
      ]);
      for (const violation of result.violations) {
        console.log(`  - ${violation.message}`);
      }
      if (!result.passed) process.exitCode = 1;
    });

  admission
    .command('approve <requestId>')
    .description('Human override: approve a pending request')
    .action(async (requestId: string) => {
      const request = await container.codeAdmissionService.approveRequest(requestId);
      printSuccess(`${request.id} approved`);
    });

  admission
    .command('reject <requestId>')
    .description('Human override: reject a pending request')
    .requiredOption('--reason <text>', 'Rejection reason')
    .action(async (requestId: string, opts: { reason: string }) => {
      const request = await container.codeAdmissionService.rejectRequest(requestId, opts.reason);
      printSuccess(`${request.id} rejected`);
    });
}
