/**
 * `orch wiki` — GitNexus wiki generate / preview / publish.
 */

import type { Command } from 'commander';
import type { LightContainer } from '../../container.js';
import { printError, printKeyValue, printSuccess } from '../output.js';
import { WikiService } from '../../application/wiki-service.js';

export function registerWikiCommand(program: Command, container: LightContainer): void {
  const wiki = program
    .command('wiki')
    .description('Generate or publish the GitNexus wiki');

  const service = (): WikiService => new WikiService(container.context.projectRoot);

  wiki
    .command('status')
    .description('Show wiki host and whether publish is allowed')
    .action(async () => {
      const status = await service().status();
      if (container.context.json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }
      printKeyValue([
        ['Host', status.host],
        ['Branch', status.current_branch],
        ['Default', status.default_branch],
        ['Can publish', status.can_publish ? 'yes' : 'no'],
        ['Bootstrap', status.bootstrap_required ? 'required' : 'ok'],
        ['Pages', String(status.pages_generated)],
      ]);
      if (status.bootstrap_required) {
        container.eventBus.emit({ type: 'wiki:bootstrap_required', provider: 'github' });
        console.log('  Enable the repository Wiki if needed and create the first page once in GitHub.');
        console.log('  After that, ORCH will own/update generated wiki pages automatically.');
        if (status.bootstrap_url) console.log(`  ${status.bootstrap_url}`);
      }
    });

  wiki
    .command('generate')
    .description('Run gitnexus wiki (writes .gitnexus/wiki; does not publish)')
    .option('--provider <name>', 'GitNexus LLM provider (claude, codex, cursor, openai, …)')
    .option('--model <name>', 'LLM model')
    .option('--api-key <key>', 'HTTP provider API key')
    .action(async (opts: { provider?: string; model?: string; apiKey?: string }) => {
      const extra: string[] = [];
      if (opts.provider) extra.push('--provider', opts.provider);
      if (opts.model) extra.push('--model', opts.model);
      if (opts.apiKey) extra.push('--api-key', opts.apiKey);
      const wikiService = service();
      container.eventBus.emit({ type: 'wiki:generation_started', mode: 'local', sha: 'pending' });
      try {
        const result = await wikiService.generate(extra);
        const status = await wikiService.status({ probeRemote: false });
        container.eventBus.emit({
          type: 'wiki:generation_completed',
          mode: 'local',
          sha: status.source_sha ?? '',
          pages: status.pages_generated,
        });
        container.eventBus.emit({ type: 'wiki:generated', branch: status.current_branch });
        console.log(result.stdout || result.stderr);
      } catch (err) {
        container.eventBus.emit({
          type: 'wiki:failed',
          stage: 'generate',
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    });

  wiki
    .command('preview')
    .description('Run gitnexus wiki preview')
    .action(async () => {
      const wikiService = service();
      container.eventBus.emit({ type: 'wiki:generation_started', mode: 'preview', sha: 'pending' });
      try {
        const result = await wikiService.preview();
        const status = await wikiService.status({ probeRemote: false });
        container.eventBus.emit({
          type: 'wiki:generation_completed',
          mode: 'preview',
          sha: status.source_sha ?? '',
          pages: status.pages_generated,
        });
        console.log(result.stdout || result.stderr);
      } catch (err) {
        container.eventBus.emit({
          type: 'wiki:failed',
          stage: 'preview',
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    });

  wiki
    .command('publish')
    .description('Publish canonical wiki (default branch only unless --force)')
    .option('--force', 'Override default-branch guard (human only)')
    .action(async (opts: { force?: boolean }) => {
      const wikiService = service();
      try {
        const before = await wikiService.status({ probeRemote: false });
        if (before.host === 'github' || before.host === 'gitlab') {
          container.eventBus.emit({
            type: 'wiki:publish_started',
            provider: before.host,
            sha: before.source_sha ?? '',
          });
        }
        const result = await wikiService.publish({
          force: opts.force,
          trustedDefaultBranch: ciTrustedWikiPublish(before.default_branch),
        });
        const after = await wikiService.status({ probeRemote: false });
        if (result.bootstrap_required) {
          container.eventBus.emit({ type: 'wiki:bootstrap_required', provider: 'github' });
          printError('BOOTSTRAP_REQUIRED');
          process.exitCode = 1;
        } else {
          const published = await wikiService.evidence('canonical-publish');
          container.eventBus.emit({
            type: 'wiki:published',
            host: after.host,
            branch: after.current_branch,
            provider: after.host === 'github' || after.host === 'gitlab' ? after.host : undefined,
            sha: after.source_sha,
            url: published.canonical_wiki_url,
            pages: result.pages_published,
          });
          printSuccess('wiki publish requested');
          await announceCanonicalWiki(container, wikiService, after);
        }
        if (result.stdout) console.log(result.stdout);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        container.eventBus.emit({ type: 'wiki:failed', stage: 'publish', error: message });
        printError(message);
        process.exitCode = 1;
      }
    });

  wiki
    .command('doctor')
    .description('Alias for wiki status')
    .action(async () => {
      const status = await service().status();
      printKeyValue([
        ['Host', status.host],
        ['Can publish', status.can_publish ? 'yes' : 'no'],
        ['Bootstrap', status.bootstrap_required ? 'required' : 'ok'],
      ]);
      if (status.bootstrap_required) {
        container.eventBus.emit({ type: 'wiki:bootstrap_required', provider: 'github' });
        console.log('  Enable the repository Wiki if needed and create the first page once in GitHub.');
        if (status.bootstrap_url) console.log(`  ${status.bootstrap_url}`);
      }
    });
}

/** Addendum §62: one wiki URL comment per Linear issue / merged PR, not per page. */
async function announceCanonicalWiki(
  container: LightContainer,
  wikiService: WikiService,
  after: Awaited<ReturnType<WikiService['status']>>,
): Promise<void> {
  const sha = after.source_sha;
  if (!sha) return;
  const wiki = await wikiService.evidence('canonical-publish');
  const tasks = await container.taskStore.list();
  const matching = tasks.filter((task) => (
    task.proof?.head_sha === sha
    && (Boolean(task.external?.linear) || task.external?.github?.pr_number !== undefined)
  ));
  if (matching.length === 0) return;
  const { ProofService } = await import('../../application/proof-service.js');
  const service = new ProofService();
  for (const task of matching) {
    const contract = container.codeAdmissionService.enabled()
      ? await container.codeAdmissionService.getContract(task.id) ?? undefined
      : undefined;
    const audit = container.codeAdmissionService.enabled()
      ? await container.codeAdmissionService.auditTask(task)
      : undefined;
    const conventionRules = (container.workflowConfig as { conventions?: {
      enabled?: boolean;
      organization?: Record<string, unknown>;
      comments?: Record<string, unknown>;
    } } | null)?.conventions;
    const conventionFiles = conventionRules?.enabled === false
      ? undefined
      : await (await import('./proof.js')).collectConventionDiffs(
        container.context.projectRoot,
        task.proof?.files_changed ?? [],
        task.proof?.branch,
      );
    const evidence = {
      ...service.build({
        task,
        audit,
        contract,
        headSha: sha,
        wiki,
        reviews: task.reviews,
        reviewPolicy: (await import('../../application/review-policy.js')).resolveReviewPolicy(
          task,
          container.workflowConfig?.review as {
            policy?: import('../../application/review-policy.js').ReviewPolicy;
            high_risk_policy?: import('../../application/review-policy.js').ReviewPolicy;
          } | undefined,
          contract,
        ),
        conventionFiles,
        conventionRules,
      }),
      verified: task.proof?.verified === true,
    };
    if (evidence.admission && audit) {
      const deps = new Set<string>();
      for (const item of audit.violations) {
        if (item.kind === 'unapproved_dependency' && item.name) deps.add(item.name);
      }
      (evidence.admission as { actual_new_dependencies?: string[] }).actual_new_dependencies = [...deps];
      const requests = await container.codeAdmissionService.listRequests(task.id);
      const extra = evidence.admission as {
        admission_requests?: string[];
        provider?: string;
        repo?: string;
        worktree?: string;
      };
      extra.admission_requests = requests.map((item) => item.id);
      extra.provider = 'gitnexus';
      extra.worktree = task.workspace;
      if (contract?.code_index.repo) extra.repo = contract.code_index.repo;
    }
    if ((evidence.reviews ?? []).some((review) => (
      (!evidence.head_sha || review.commit_sha === evidence.head_sha)
      && (review.verdict === 'changes_requested' || review.verdict === 'failed')
    ))) {
      evidence.verified = false;
    }
    if (!evidence.verified) delete evidence.verified_at;
    try {
      if (container.integrationService.enabled() && task.external?.linear) {
        await container.integrationService.publishProof(task, evidence);
        console.log(`Linear wiki URL updated for ${task.id}`);
      }
    } catch (err) {
      console.log(`Linear wiki comment skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      if (task.external?.github?.pr_number !== undefined) {
        const { GitHubProofPublisher } = await import('../../infrastructure/proof/github-publisher.js');
        await new GitHubProofPublisher().publish(task, evidence);
        console.log(`GitHub wiki URL updated for ${task.id}`);
      }
    } catch (err) {
      console.log(`GitHub wiki comment skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Addendum §52.1: CI default-branch push may be detached HEAD; PRs must never be trusted. */
function ciTrustedWikiPublish(defaultBranch: string): boolean {
  const normalize = (value: string): string => value.replace(/^refs\/heads\//, '');
  const expected = normalize(defaultBranch);
  if (process.env['GITHUB_ACTIONS'] === 'true') {
    if (process.env['GITHUB_EVENT_NAME'] === 'pull_request') return false;
    const ref = process.env['GITHUB_REF_NAME'] ?? process.env['GITHUB_REF'] ?? '';
    return normalize(ref) === expected;
  }
  if (process.env['GITLAB_CI'] === 'true') {
    if (process.env['CI_PIPELINE_SOURCE'] === 'merge_request_event') return false;
    const ref = process.env['CI_COMMIT_REF_NAME'] ?? '';
    const named = process.env['CI_DEFAULT_BRANCH'] ?? expected;
    return ref === named;
  }
  return false;
}
