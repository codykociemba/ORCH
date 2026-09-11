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
    .option('--analyze', 'Force gitnexus analyze even if auto_analyze is false')
    .action(async (opts: { analyze?: boolean }) => {
      const { pathExists, atomicWrite, writeYaml } = await import('../../infrastructure/storage/fs-utils.js');
      const { DEFAULT_WORKFLOW_CONFIG, DEFAULT_COMPOUND_YML } = await import('../../domain/workflow-config.js');
      const path = await import('node:path');
      const orchDir = path.join(container.context.projectRoot, '.orch');
      const workflowPath = path.join(orchDir, 'workflow.yml');
      const compoundPath = path.join(orchDir, 'compound.yml');
      if (!(await pathExists(workflowPath))) {
        await writeYaml(workflowPath, DEFAULT_WORKFLOW_CONFIG);
        printSuccess('wrote .orch/workflow.yml (admission disabled until you enable it)');
      }
      if (!(await pathExists(compoundPath))) {
        await atomicWrite(compoundPath, DEFAULT_COMPOUND_YML);
        printSuccess('wrote .orch/compound.yml');
      }
      await copyWorkflowCiTemplates(container.context.projectRoot, pathExists);
      console.log(dim('  Edit .orch/workflow.yml'));
      console.log('  code_admission.enabled: true');
      console.log('  linear.enabled: true   # then: orch integration login');
      console.log('  linear.status_owner: hybrid  # orch | linear-github | hybrid');
      console.log('  GitHub: logged-in `gh` is enough locally; GITHUB_TOKEN is only for CI');
      if (detectWslGitnexus()) {
        console.log('  GitNexus: WSL2 detected — ORCH will call `wsl` (supported runtime)');
      } else {
        console.log('  Install gitnexus on Linux/macOS/WSL2; setup analyzes when auto_analyze is true');
        console.log('  Native Windows is best-effort (LadybugDB FTS often needs OpenSSL/VC++)');
      }
      console.log('  CE methodology: .orch/compound.yml (ORCH stays the scheduler)');
      console.log('  Wiki: orch wiki generate (needs GITNEXUS_WIKI_PROVIDER / GITNEXUS_WIKI_API_KEY or a local CLI provider)');
      const { WikiService } = await import('../../application/wiki-service.js');
      const wiki = new WikiService(container.context.projectRoot);
      const status = await wiki.status();
      if (status.bootstrap_required) {
        container.eventBus.emit({ type: 'wiki:bootstrap_required', provider: 'github' });
        console.log('  Enable the repository Wiki if needed and create the first page once in GitHub.');
        console.log('  After that, ORCH will own/update generated wiki pages automatically.');
        if (status.bootstrap_url) console.log(`  ${status.bootstrap_url}`);
      }
      const wikiLocal = container.workflowConfig?.wiki as { local?: { generate_on_setup?: boolean } } | undefined;
      if (wikiLocal?.local?.generate_on_setup === false) {
        console.log(dim('  Wiki generate skipped (wiki.local.generate_on_setup: false)'));
      } else try {
        container.eventBus.emit({ type: 'wiki:generation_started', mode: 'local', sha: status.source_sha ?? '' });
        await wiki.generate();
        const after = await wiki.status({ probeRemote: false });
        container.eventBus.emit({
          type: 'wiki:generation_completed',
          mode: 'local',
          sha: after.source_sha ?? '',
          pages: after.pages_generated,
        });
        printSuccess('GitNexus wiki generate finished');
      } catch (wikiErr) {
        container.eventBus.emit({
          type: 'wiki:failed',
          stage: 'generate',
          error: wikiErr instanceof Error ? wikiErr.message : String(wikiErr),
        });
        printError(wikiErr instanceof Error ? wikiErr.message : String(wikiErr));
        console.log(dim('  Set GITNEXUS_WIKI_API_KEY or --provider claude/codex/cursor to generate pages.'));
        console.log(dim('  Local wiki is optional here — CI remains the authoritative preview.'));
      }
      const autoAnalyze = container.workflowConfig?.code_intelligence?.setup?.auto_analyze !== false;
      if (!opts.analyze && !autoAnalyze) {
        console.log(dim('  GitNexus analyze skipped (code_intelligence.setup.auto_analyze: false)'));
        return;
      }
      try {
        const intelligence = new GitNexusCodeIntelligence({
          projectRoot: container.context.projectRoot,
        });
        await intelligence.analyze({ repository_root: container.context.projectRoot });
        const index = await intelligence.getRepositoryStatus({
          repository_root: container.context.projectRoot,
        });
        container.eventBus.emit({
          type: index.current ? 'code_intelligence:index_refreshed' : 'code_intelligence:index_stale',
          repo: index.repo,
        });
        printSuccess('GitNexus analyze finished');
      } catch (err) {
        printError(err instanceof Error ? err.message : String(err));
        if (opts.analyze) process.exitCode = 1;
        else console.log(dim('  GitNexus analyze is optional here — run orch workflow setup --analyze or orch code analyze.'));
      }
    });

  workflow
    .command('doctor')
    .description('Summarize workflow configuration')
    .action(async () => {
      const cfg = container.workflowConfig;
      const root = container.context.projectRoot;
      const { pathExists } = await import('../../infrastructure/storage/fs-utils.js');
      const path = await import('node:path');
      const compound = await pathExists(path.join(root, '.orch', 'compound.yml'));
      const admissionRule = await pathExists(path.join(root, '.cursor', 'rules', 'orch-code-admission.mdc'));
      const cursorReview = await pathExists(path.join(root, '.github', 'workflows', 'cursor-review.yml'));
      printKeyValue([
        ['File', container.workflowConfig ? '.orch/workflow.yml' : 'missing (admission off)'],
        ['Admission', cfg?.code_admission?.enabled ? 'enabled' : 'disabled'],
        ['Linear', cfg?.linear?.enabled
          ? (container.integrationService.enabled() ? 'configured' : 'enabled — login required')
          : 'disabled'],
        ['Linear status owner', (cfg?.linear as { status_owner?: string } | undefined)?.status_owner ?? 'hybrid'],
        ['Council @', String(cfg?.council?.required_task_count ?? 5)],
        ['Review policy', (cfg?.review as { policy?: string; high_risk_policy?: string } | undefined)?.policy
          ?? 'human_or_cursor'],
        ['High-risk review', (cfg?.review as { high_risk_policy?: string } | undefined)?.high_risk_policy
          ?? 'same'],
        ['Ponytail', cfg?.ponytail?.enabled === false ? 'off' : 'on'],
        ['Wiki', cfg?.wiki?.enabled === false ? 'off' : 'on'],
        ['Wiki ownership', (cfg?.wiki as { publish?: { ownership?: string }; ownership?: string } | undefined)
          ?.publish?.ownership
          ?? (cfg?.wiki as { ownership?: string } | undefined)?.ownership
          ?? 'generated_pages'],
        ['GitNexus auto-analyze', cfg?.code_intelligence?.setup?.auto_analyze === false ? 'off' : 'on'],
        ['Wiki extra hosts', (() => {
          const extra = cfg?.wiki as { github_hosts?: string[]; gitlab_hosts?: string[] } | undefined;
          const hosts = [...(extra?.github_hosts ?? []), ...(extra?.gitlab_hosts ?? [])]
            .filter((host) => host && host !== 'github.com' && host !== 'gitlab.com');
          return hosts.length > 0 ? hosts.join(', ') : 'none';
        })()],
        ['CE compound.yml', compound ? 'present' : 'missing — orch workflow setup'],
        ['Admission rule', admissionRule ? 'present' : 'missing .cursor/rules/orch-code-admission.mdc'],
        ['Cursor review Action', cursorReview ? 'present — set CURSOR_API_KEY for trusted PRs' : 'missing workflow'],
      ]);
    });
}

/** Addendum §48.1: copy wiki/review CI templates when this checkout still has them. */
export async function copyWorkflowCiTemplates(
  projectRoot: string,
  pathExists: (file: string) => Promise<boolean>,
): Promise<void> {
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { copyFile, mkdir } = await import('node:fs/promises');
  const marker = '.github/workflows/wiki-preview.yml';
  let repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
  for (let depth = 0; depth < 8; depth += 1) {
    if (await pathExists(path.join(repoRoot, marker))) break;
    const parent = path.dirname(repoRoot);
    if (parent === repoRoot) break;
    repoRoot = parent;
  }
  const templates = [
    ['.github/workflows/wiki-preview.yml', 'wiki preview CI'],
    ['.github/workflows/wiki-publish.yml', 'wiki publish CI'],
    ['.github/workflows/cursor-review.yml', 'Cursor review Action'],
    ['.github/cursor-review-prompt.md', 'Cursor review prompt'],
    ['scripts/cursor-pr-review.mjs', 'Cursor review publisher'],
    ['.gitlab-ci-wiki.yml', 'GitLab wiki CI'],
  ] as const;
  let copied = 0;
  for (const [rel, label] of templates) {
    const dest = path.join(projectRoot, rel);
    if (await pathExists(dest)) continue;
    const src = path.join(repoRoot, rel);
    if (!(await pathExists(src))) continue;
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(src, dest);
    printSuccess(`wrote ${rel} (${label})`);
    copied += 1;
  }
  const { readYaml, writeYaml } = await import('../../infrastructure/storage/fs-utils.js');
  const workflowPath = path.join(projectRoot, '.orch', 'workflow.yml');
  if (await pathExists(workflowPath)) {
    const raw = await readYaml<Record<string, unknown>>(workflowPath);
    if (raw && typeof raw === 'object') {
      const intel = raw['code_intelligence'] && typeof raw['code_intelligence'] === 'object'
        ? { ...(raw['code_intelligence'] as Record<string, unknown>) }
        : {};
      const admission = raw['code_admission'] && typeof raw['code_admission'] === 'object'
        ? { ...(raw['code_admission'] as Record<string, unknown>) }
        : {};
      const intelChanged = intel['required'] !== true;
      const admissionChanged = admission['enabled'] !== true;
      const pdg: Record<string, unknown> = intel['pdg'] && typeof intel['pdg'] === 'object'
        ? { ...(intel['pdg'] as Record<string, unknown>) }
        : { default: false };
      const wanted = ['security', 'auth', 'payments', 'concurrency', 'dataflow-sensitive'];
      const have = Array.isArray(pdg['required_for']) ? pdg['required_for'] as unknown[] : [];
      const pdgChanged = wanted.some((item) => !have.includes(item));
      if (intelChanged || admissionChanged || pdgChanged) {
        if (intelChanged) intel['required'] = true;
        if (admissionChanged) admission['enabled'] = true;
        if (pdgChanged) {
          pdg['required_for'] = [...new Set([...have.filter((item) => typeof item === 'string'), ...wanted])];
          intel['pdg'] = pdg;
        }
        raw['code_intelligence'] = intel;
        raw['code_admission'] = admission;
        await writeYaml(workflowPath, raw);
        if (intelChanged) printSuccess('set code_intelligence.required: true in .orch/workflow.yml');
        if (admissionChanged) printSuccess('set code_admission.enabled: true in .orch/workflow.yml');
        if (pdgChanged) printSuccess('set code_intelligence.pdg.required_for in .orch/workflow.yml');
      }
    }
  }
  const conventionsPath = path.join(projectRoot, '.orch', 'conventions.yml');
  const conventionDefaults = {
    version: 1,
    organization: {
      prefer_edit_existing: true,
      no_parallel_utils: true,
      allowed_new_file_roots: ['src/', 'test/', 'docs/'],
      forbidden_new_file_globs: ['**/utils/**', '**/helpers/**', '**/lib/misc/**'],
      max_new_files_per_task: 8,
    },
    comments: {
      style: 'file_header_only',
      header_required_on_new_files: true,
      header_max_lines: 4,
      header_min_lines: 1,
      no_inline_comments: true,
      no_jsdoc_on_functions: true,
      allowed_inline_patterns: [
        '^\\s*//\\s*eslint-disable',
        '^\\s*//\\s*@ts-expect-error',
        '^\\s*//\\s*@ts-ignore',
        '^\\s*/\\*\\s*c8 ignore',
      ],
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    },
  };
  if (!(await pathExists(conventionsPath))) {
    await mkdir(path.dirname(conventionsPath), { recursive: true });
    await writeYaml(conventionsPath, conventionDefaults);
    printSuccess('wrote .orch/conventions.yml');
  } else {
    const current = await readYaml<Record<string, unknown>>(conventionsPath);
    if (current && typeof current === 'object') {
      let changed = false;
      if (current['version'] === undefined) {
        current['version'] = conventionDefaults.version;
        changed = true;
      }
      const org = current['organization'] && typeof current['organization'] === 'object'
        ? { ...(current['organization'] as Record<string, unknown>) }
        : {};
      if (current['organization'] === undefined) {
        current['organization'] = conventionDefaults.organization;
        changed = true;
      } else {
        for (const [key, value] of Object.entries(conventionDefaults.organization)) {
          if (org[key] === undefined) {
            org[key] = value;
            changed = true;
          }
        }
        current['organization'] = org;
      }
      const comments = current['comments'] && typeof current['comments'] === 'object'
        ? { ...(current['comments'] as Record<string, unknown>) }
        : {};
      if (current['comments'] === undefined) {
        current['comments'] = conventionDefaults.comments;
        changed = true;
      } else {
        for (const [key, value] of Object.entries(conventionDefaults.comments)) {
          if (comments[key] === undefined) {
            comments[key] = value;
            changed = true;
          }
        }
        current['comments'] = comments;
      }
      if (changed) {
        await writeYaml(conventionsPath, current);
        printSuccess('merged new keys into .orch/conventions.yml');
      }
    }
  }
  if (copied === 0) {
    console.log(dim('  CI templates already present (or unavailable from this install)'));
  }
}
