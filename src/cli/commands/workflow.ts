/**
 * `orch workflow` setup / doctor.
 */

import type { Command } from 'commander';
import type { LightContainer } from '../../container.js';
import { printKeyValue, printError, printSuccess, dim } from '../output.js';
import { detectWslGitnexus } from '../../infrastructure/code-intelligence/cli-runner.js';
import { GitNexusCodeIntelligence } from '../../infrastructure/code-intelligence/gitnexus-adapter.js';

export function registerWorkflowCommand(program: Command, container: LightContainer): void {
  const workflow = program
    .command('workflow')
    .description('Team workflow config (.orch/workflow.yml)');

  workflow
    .command('setup')
    .description('Show how to enable admission, Linear, and GitNexus')
    .option('--analyze', 'Run gitnexus analyze after printing setup hints')
    .action(async (opts: { analyze?: boolean }) => {
      console.log(dim('  Edit .orch/workflow.yml'));
      console.log('  code_admission.enabled: true');
      console.log('  linear.enabled: true   # plus LINEAR_API_KEY');
      if (detectWslGitnexus()) {
        console.log('  GitNexus: WSL2 detected — ORCH will call `wsl` (supported runtime)');
      } else {
        console.log('  Install gitnexus on Linux/macOS/WSL2, then: orch workflow setup --analyze');
        console.log('  Native Windows is best-effort (LadybugDB FTS often needs OpenSSL/VC++)');
      }
      console.log('  CE methodology: .orch/compound.yml (ORCH stays the scheduler)');
      if (!opts.analyze) return;
      try {
        const intelligence = new GitNexusCodeIntelligence({
          projectRoot: container.context.projectRoot,
        });
        await intelligence.analyze({ repository_root: container.context.projectRoot });
        printSuccess('GitNexus analyze finished');
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  workflow
    .command('doctor')
    .description('Summarize workflow configuration')
    .action(() => {
      const cfg = container.workflowConfig;
      printKeyValue([
        ['File', container.workflowConfig ? '.orch/workflow.yml' : 'missing (admission off)'],
        ['Admission', cfg?.code_admission?.enabled ? 'enabled' : 'disabled'],
        ['Linear', cfg?.linear?.enabled ? 'enabled' : 'disabled'],
        ['Council @', String(cfg?.council?.required_task_count ?? 5)],
        ['Ponytail', cfg?.ponytail?.enabled === false ? 'off' : 'on'],
        ['Wiki', cfg?.wiki?.enabled === false ? 'off' : 'on'],
      ]);
    });
}
