/**
 * `orch proof` — show / publish verification evidence.
 */

import type { Command } from 'commander';
import type { LightContainer } from '../../container.js';
import { printError } from '../output.js';
import { ProofService } from '../../application/proof-service.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function registerProofCommand(program: Command, container: LightContainer): void {
  const proof = program
    .command('proof')
    .description('Show or publish verification proof');

  proof
    .command('show <taskId>')
    .description('Render GitHub-style proof for a task')
    .action(async (taskId: string) => {
      const body = await buildProof(container, taskId);
      if (!body) return;
      if (container.context.json) {
        console.log(JSON.stringify(body.evidence, null, 2));
        return;
      }
      console.log(body.markdown);
    });

  proof
    .argument('[taskId]')
    .description('Alias for proof show')
    .action(async (taskId?: string) => {
      if (!taskId) return;
      const body = await buildProof(container, taskId);
      if (!body) return;
      console.log(body.markdown);
    });

  proof
    .command('publish <taskId>')
    .description('Publish proof to Linear and/or GitHub PR, bound to HEAD SHA')
    .option('--github', 'Also comment on the linked GitHub PR via gh')
    .action(async (taskId: string, opts: { github?: boolean }) => {
      const body = await buildProof(container, taskId);
      if (!body) return;
      const task = await container.taskStore.get(taskId);
      if (!task) return;
      let published = false;
      if (container.integrationService.enabled()) {
        await container.integrationService.publishProof(task, body.evidence);
        console.log('Published Linear proof comment');
        published = true;
      }
      if (opts.github || task.external?.github?.pr_number) {
        const { GitHubProofPublisher } = await import('../../infrastructure/proof/github-publisher.js');
        const action = await new GitHubProofPublisher().publish(task, body.evidence);
        console.log(action === 'updated'
          ? 'GitHub proof already posted for this SHA (not duplicated)'
          : 'Published GitHub PR proof comment');
        published = true;
      }
      if (!published) {
        printError('Nothing to publish — enable Linear or link a PR (`orch pr link`)');
        process.exitCode = 1;
      }
    });
}

async function buildProof(container: LightContainer, taskId: string): Promise<{
  evidence: ReturnType<ProofService['build']>;
  markdown: string;
} | null> {
  const task = await container.taskStore.get(taskId);
  if (!task) {
    printError(`Task not found: ${taskId}`);
    process.exitCode = 1;
    return null;
  }
  const audit = container.codeAdmissionService.enabled()
    ? await container.codeAdmissionService.auditTask(task)
    : undefined;
  let headSha: string | undefined;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: container.context.projectRoot });
    headSha = stdout.trim();
  } catch {
    headSha = undefined;
  }
  const { ReviewStore } = await import('../../infrastructure/storage/review-store.js');
  const reviews = await new ReviewStore(container.paths).list(task.id);
  const service = new ProofService();
  const evidence = service.build({
    task,
    audit,
    headSha,
    reviews: reviews.length > 0 ? reviews : task.reviews,
  });
  return { evidence, markdown: service.renderGitHub(evidence) };
}
