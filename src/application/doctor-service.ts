/**
 * Doctor service — diagnostics and health checks.
 *
 * Checks adapter availability, system dependencies, project state.
 */

import type { AdapterRegistry } from '../infrastructure/adapters/registry.js';
import type { IProcessManager } from '../infrastructure/process/process-manager.js';
import { detectWslGitnexus, gitnexusBin, resolveGitnexusSpawn } from '../infrastructure/code-intelligence/cli-runner.js';
import { probeLinearApiKey, resolveLinearApiKey } from '../infrastructure/integrations/linear/linear-issue-tracker.js';
import { Paths } from '../infrastructure/storage/paths.js';
import { TaskStore } from '../infrastructure/storage/task-store.js';
import { WorkflowConfigStore } from '../infrastructure/storage/workflow-config-store.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'fail' | 'skip';
  detail?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  adaptersReady: number;
  adaptersTotal: number;
}

export class DoctorService {
  private readonly cwd: string;

  constructor(
    private readonly adapterRegistry: AdapterRegistry,
    private readonly processManager: IProcessManager,
    projectRoot?: string,
  ) {
    this.cwd = projectRoot ?? process.cwd();
  }

  async runAll(): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];

    // Check adapters
    const adapters = this.adapterRegistry.list();
    let adaptersReady = 0;

    for (const adapter of adapters) {
      const result = await adapter.test();
      if (result.ok) {
        adaptersReady++;
        checks.push({
          name: adapter.kind,
          status: 'ok',
          detail: result.version,
        });
      } else {
        checks.push({
          name: adapter.kind,
          status: 'fail',
          detail: result.error,
        });
      }
    }

    // Check git
    checks.push(await this.checkCommand('git', ['--version'], 'git'));

    // Check git repository (required for worktree/isolated workspace modes)
    checks.push(await this.checkGitRepo());

    // Check .orchestry in root .gitignore (prevents recursive worktrees)
    checks.push(await this.checkGitignore());

    // Check node
    checks.push(await this.checkCommand('node', ['--version'], 'node'));

    checks.push(...await this.checkGitNexusStack());
    checks.push(this.checkPonytailHint());
    {
      const workflow = await new WorkflowConfigStore(this.cwd).read();
      const conventions = (workflow as {
        conventions?: { enabled?: boolean; organization?: { max_new_files_per_task?: number } };
      } | null)?.conventions;
      checks.push({
        name: 'conventions',
        status: conventions?.enabled === true ? 'ok' : 'skip',
        detail: conventions?.enabled === true
          ? `enabled — dispatch injects YAML rules; orch admission audit / orch proof enforce them (max ${conventions.organization?.max_new_files_per_task ?? 8} new files)`
          : 'not enabled — conventions gate skipped',
      });
    }
    checks.push(await this.checkWiki());
    checks.push(await this.checkGitHubCli());
    checks.push(await this.checkLinearAuth());
    checks.push(...await this.checkTeamWorkflowPrereqs());

    const optional = new Set(['opencode', 'pi', 'grok', 'antigravity', 'ponytail']);
    if (checks.some((check) => check.status === 'fail' && !optional.has(check.name))) {
      process.exitCode = 1;
    }

    return {
      checks,
      adaptersReady,
      adaptersTotal: adapters.length,
    };
  }

  private async checkCommand(
    command: string,
    args: string[],
    name: string,
  ): Promise<DoctorCheck> {
    try {
      const { stdout } = await execFileAsync(command, args);
      return { name, status: 'ok', detail: stdout.trim() };
    } catch {
      return { name, status: 'fail', detail: `${command}: command not found` };
    }
  }

  private async checkGitignore(): Promise<DoctorCheck> {
    const gitignorePath = path.join(this.cwd, '.gitignore');
    try {
      const content = await fs.readFile(gitignorePath, 'utf-8');
      const hasEntry = content.split('\n').some((line) => line.trim() === '.orchestry');
      if (hasEntry) {
        return { name: '.gitignore', status: 'ok', detail: '.orchestry is excluded' };
      }
      return {
        name: '.gitignore',
        status: 'fail',
        detail: '.orchestry not in .gitignore — worktrees will copy state recursively. Run: orch init',
      };
    } catch {
      return {
        name: '.gitignore',
        status: 'fail',
        detail: 'no .gitignore found — .orchestry may be committed to git. Run: orch init',
      };
    }
  }

  private async checkGitNexus(): Promise<DoctorCheck> {
    const nativeWindows = process.platform === 'win32' && !process.env['WSL_DISTRO_NAME'];
    const invoked = resolveGitnexusSpawn(gitnexusBin(), ['--version']);
    const result = await this.checkCommand(invoked.command, invoked.args, 'gitnexus');
    if (result.status === 'ok') {
      return {
        ...result,
        detail: nativeWindows
          ? `${result.detail} — prefer WSL2 GitNexus (set GITNEXUS_BIN=wsl); native Windows is best-effort`
          : result.detail,
      };
    }
    return {
      name: 'gitnexus',
      status: nativeWindows ? 'skip' : 'fail',
      detail: nativeWindows
        ? 'GitNexus not on PATH. Supported on Linux/macOS/WSL2; native Windows is best-effort.'
        : 'gitnexus: command not found — install GitNexus for code admission',
    };
  }

  private async checkGitNexusStack(): Promise<DoctorCheck[]> {
    const required = (await new WorkflowConfigStore(this.cwd).read())?.code_intelligence?.required === true;
    const binary = await this.checkGitNexus();
    const checks: DoctorCheck[] = [
      required && binary.status === 'skip'
        ? { ...binary, status: 'fail', detail: `${binary.detail} — code_intelligence.required` }
        : binary,
    ];
    if (checks[0]?.status !== 'ok') {
      checks.push({
        name: 'gitnexus index',
        status: required ? 'fail' : 'skip',
        detail: 'GitNexus CLI unavailable — index/MCP checks skipped',
      });
      return checks;
    }
    try {
      const { GitNexusCodeIntelligence } = await import('../infrastructure/code-intelligence/gitnexus-adapter.js');
      const intel = new GitNexusCodeIntelligence({ projectRoot: this.cwd });
      const status = await intel.getRepositoryStatus({ repository_root: this.cwd });
      const indexHint = status.available
        ? status.repo
        : `${status.repo || 'not indexed'} — if analyze OOMs, set GITNEXUS_LBUG_BUFFER_POOL_SIZE=2147483648`;
      checks.push({
        name: 'gitnexus index',
        status: status.available ? 'ok' : 'fail',
        detail: indexHint,
      });
      const freshness = status.incomplete_reasons.filter(Boolean).join(', ');
      const currentDetail = [
        status.index_commit,
        !status.current && freshness ? freshness : '',
      ].filter(Boolean).join(' — ') || 'index not current';
      checks.push({
        name: 'gitnexus current',
        status: status.current ? 'ok' : 'fail',
        detail: detectWslGitnexus()
          ? `${currentDetail} — using WSL2 GitNexus`
          : process.platform === 'win32'
            ? `${currentDetail} — native Windows is best-effort; prefer GITNEXUS_BIN=wsl`
            : currentDetail,
      });
      try {
        await intel.detectChanges({ worktree: '' });
        checks.push({
          name: 'gitnexus detect_changes worktree',
          status: 'fail',
          detail: 'detect_changes accepted an empty worktree — a wrong-checkout zero would look like success',
        });
      } catch {
        checks.push({
          name: 'gitnexus detect_changes worktree',
          status: 'ok',
          detail: 'detect_changes requires an explicit worktree (wrong-checkout zero is not success)',
        });
      }
      const fixture = path.join(this.cwd, '.orchestry', 'doctor-detect-wt');
      try {
        await execFileAsync('git', ['worktree', 'remove', '--force', fixture], {
          cwd: this.cwd,
          windowsHide: true,
        }).catch(() => {});
        await fs.rm(fixture, { recursive: true, force: true }).catch(() => {});
        await execFileAsync('git', ['worktree', 'add', '--detach', fixture, 'HEAD'], {
          cwd: this.cwd,
          windowsHide: true,
        });
        const changes = await intel.detectChanges({ worktree: fixture });
        const bound = path.resolve(changes.worktree) === path.resolve(fixture);
        checks.push({
          name: 'gitnexus linked worktree',
          status: bound ? 'ok' : 'fail',
          detail: bound
            ? `detect_changes bound to temporary worktree ${path.relative(this.cwd, fixture)}`
            : `detect_changes worktree ${changes.worktree} ≠ ${fixture}`,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        checks.push({
          name: 'gitnexus linked worktree',
          status: /requires an explicit worktree/i.test(message) ? 'fail' : 'skip',
          detail: message,
        });
      } finally {
        await execFileAsync('git', ['worktree', 'remove', '--force', fixture], {
          cwd: this.cwd,
          windowsHide: true,
        }).catch(() => {});
        await fs.rm(fixture, { recursive: true, force: true }).catch(() => {});
      }
    } catch (err) {
      checks.push({
        name: 'gitnexus index',
        status: 'fail',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    checks.push(await this.checkGitNexusMcp());
    return checks;
  }

  private async checkGitNexusMcp(): Promise<DoctorCheck> {
    const { createGitNexusIntelligence } = await import('../infrastructure/code-intelligence/gitnexus-adapter.js');
    const handle = createGitNexusIntelligence(this.cwd);
    try {
      const hits = await Promise.race([
        handle.intelligence.searchExisting({ query: 'WikiService', limit: 1 }),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('MCP probe timed out after 15s')), 15_000);
        }),
      ]);
      return {
        name: 'gitnexus mcp',
        status: 'ok',
        detail: `MCP connected — probe returned ${hits.length} hit(s)`,
      };
    } catch (err) {
      return {
        name: 'gitnexus mcp',
        status: 'fail',
        detail: err instanceof Error ? err.message : String(err),
      };
    } finally {
      await handle.close?.();
    }
  }

  private async checkWiki(): Promise<DoctorCheck> {
    try {
      const { WikiService } = await import('./wiki-service.js');
      const wiki = new WikiService(this.cwd);
      const status = await wiki.status();
      if (status.host === 'unknown') {
        return {
          name: 'wiki',
          status: 'fail',
          detail: 'Ambiguous or unknown wiki host — set wiki.provider in .orch/workflow.yml',
        };
      }
      if (status.pages_generated === 0) {
        return {
          name: 'wiki',
          status: 'fail',
          detail: `${status.host} · no generated pages — run orch wiki generate`,
        };
      }
      if (status.bootstrap_required) {
        return {
          name: 'wiki',
          status: 'fail',
          detail: status.bootstrap_url
            ? `GitHub wiki bootstrap required — create the first page at ${status.bootstrap_url}`
            : 'GitHub wiki bootstrap required — create the first page, then orch wiki publish',
        };
      }
      if (!status.index_current) {
        return {
          name: 'wiki',
          status: 'fail',
          detail: 'GitNexus index is not current — wiki is not architectural truth. Run analyze --index-only',
        };
      }
      const origin = status.origin ?? '';
      const webHost = /https?:\/\/([^/@]+)/i.exec(origin)?.[1]
        ?? /@([^:]+):/.exec(origin)?.[1];
      const home = status.owner && status.repo
        ? status.host === 'gitlab'
          ? `https://${webHost || 'gitlab.com'}/${status.owner}/${status.repo}/-/wikis/home`
          : `https://${webHost || 'github.com'}/${status.owner}/${status.repo}/wiki`
        : undefined;
      return {
        name: 'wiki',
        status: 'ok',
        detail: [
          `${status.host} · ${status.pages_generated} generated page(s)`,
          `can publish ${status.can_publish ? 'yes' : 'no'}`,
          home,
        ].filter(Boolean).join(' · '),
      };
    } catch (err) {
      return {
        name: 'wiki',
        status: 'fail',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private checkPonytailHint(): DoctorCheck {
    return {
      name: 'ponytail',
      status: 'skip',
      detail: 'Optional behavioral nudge (https://github.com/DietrichGebert/ponytail). Defaults: planning off, implementation lite (full only for low-risk bounded), review off. Not an enforcement gate.',
    };
  }

  private async checkGitHubCli(): Promise<DoctorCheck> {
    try {
      const { stdout, stderr } = await execFileAsync('gh', ['auth', 'status'], { windowsHide: true });
      const text = `${stdout}\n${stderr}`;
      if (/Logged in/i.test(text)) {
        return {
          name: 'gh',
          status: 'ok',
          detail: 'GitHub CLI authenticated — proof, PRs, and wiki publish use `gh`, not GITHUB_TOKEN',
        };
      }
      return {
        name: 'gh',
        status: 'fail',
        detail: 'gh is installed but not logged in. Run: gh auth login',
      };
    } catch {
      return {
        name: 'gh',
        status: 'fail',
        detail: 'gh not found. Install GitHub CLI and run `gh auth login`',
      };
    }
  }

  private async checkLinearAuth(): Promise<DoctorCheck> {
    const apiKey = resolveLinearApiKey();
    const workflow = await new WorkflowConfigStore(this.cwd).read();
    const required = workflow?.linear?.required_before_dispatch === true;
    const enabled = workflow?.linear?.enabled === true;
    let missingLinear = 0;
    try {
      missingLinear = (await new TaskStore(new Paths(this.cwd)).list())
        .filter((task) => task.status !== 'cancelled' && !task.external?.linear?.id)
        .length;
    } catch {
      missingLinear = 0;
    }
    const missingNote = missingLinear > 0
      ? `${missingLinear} task(s) have no Linear issue`
      : '';
    if (!apiKey) {
      return {
        name: 'linear',
        status: enabled || required ? 'fail' : 'skip',
        detail: [
          required
            ? 'Linear is required_before_dispatch but login is missing. Run `orch integration login`.'
            : enabled
              ? 'Linear is enabled but login is missing. Run `orch integration login`.'
              : 'Run `orch integration login` (Linear desktop / Cursor MCP cannot authenticate this CLI).',
          missingNote,
        ].filter(Boolean).join(' '),
      };
    }
    try {
      const probe = await new Promise<Awaited<ReturnType<typeof probeLinearApiKey>>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Linear probe timed out after 15s')), 15_000);
        probeLinearApiKey(apiKey).then((value) => {
          clearTimeout(timer);
          resolve(value);
        }, (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      const teamKey = workflow?.linear?.team_key?.trim();
      if (teamKey && !probe.teams.some((team) => team.toLowerCase() === teamKey.toLowerCase())) {
        return {
          name: 'linear',
          status: 'fail',
          detail: `Linear team not found: ${teamKey} (available: ${probe.teams.join(', ') || 'none'})`,
        };
      }
      if (enabled && missingLinear > 0) {
        return {
          name: 'linear',
          status: 'fail',
          detail: `${missingNote} — orch integration retry, or any orch command after login so tasks that never got an outbox get issues`,
        };
      }
      let states = 0;
      let labels = 0;
      try {
        const wanted = (teamKey || probe.teams[0] || '').toLowerCase();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        const response = await fetch('https://api.linear.app/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: apiKey },
          signal: controller.signal,
          body: JSON.stringify({
            query: '{ teams { nodes { key states { nodes { name } } labels { nodes { name } } } } }',
          }),
        }).finally(() => clearTimeout(timer));
        const payload = await response.json() as {
          data?: {
            teams: {
              nodes: Array<{
                key: string;
                states: { nodes: Array<{ name: string }> };
                labels: { nodes: Array<{ name: string }> };
              }>;
            };
          };
        };
        const team = payload.data?.teams.nodes.find((node) => node.key.toLowerCase() === wanted)
          ?? payload.data?.teams.nodes[0];
        states = team?.states.nodes.length ?? 0;
        labels = team?.labels.nodes.length ?? 0;
        if (states === 0) {
          return {
            name: 'linear',
            status: 'fail',
            detail: `Linear team ${team?.key ?? (wanted || 'unknown')} has no workflow states to resolve`,
          };
        }
      } catch {
        // Fail-open: viewer/team auth already succeeded.
      }
      return {
        name: 'linear',
        status: 'ok',
        detail: [
          teamKey
            ? `${probe.name} · team ${teamKey}`
            : `${probe.name} · ${probe.teams.length} team(s)${probe.teams[0] ? ` · default ${probe.teams[0]}` : ''}`,
          states > 0 ? `${states} state(s) / ${labels} label(s)` : '',
          required ? 'required_before_dispatch' : '',
        ].filter(Boolean).join(' · '),
      };
    } catch (err) {
      return {
        name: 'linear',
        status: 'fail',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async checkTeamWorkflowPrereqs(): Promise<DoctorCheck[]> {
    const compound = path.join(this.cwd, '.orch', 'compound.yml');
    const admissionRule = path.join(this.cwd, '.cursor', 'rules', 'orch-code-admission.mdc');
    const cursorReview = path.join(this.cwd, '.github', 'workflows', 'cursor-review.yml');
    const wikiPreview = path.join(this.cwd, '.github', 'workflows', 'wiki-preview.yml');
    const wikiPublish = path.join(this.cwd, '.github', 'workflows', 'wiki-publish.yml');
    const conventionsYml = path.join(this.cwd, '.orch', 'conventions.yml');
    const origin = await this.gitOrigin();
    const workflow = await new WorkflowConfigStore(this.cwd).read();
    const conventionsEnabled = (workflow as { conventions?: { enabled?: boolean } } | null)?.conventions?.enabled === true;
    let conventionsFile: DoctorCheck;
    try {
      await fs.access(conventionsYml);
      conventionsFile = {
        name: 'conventions.yml',
        status: 'ok',
        detail: 'merge-gate overlay — orch workflow setup writes this once',
      };
    } catch {
      conventionsFile = {
        name: 'conventions.yml',
        status: conventionsEnabled ? 'ok' : 'skip',
        detail: conventionsEnabled
          ? 'optional overlay missing — merge-gate rules live in .orch/workflow.yml'
          : 'missing .orch/conventions.yml — conventions gate uses workflow.yml when enabled',
      };
    }
    const leadIntegrations: DoctorCheck[] = [];
    for (const item of [
      { kind: 'claude', name: 'Claude integration' },
      { kind: 'cursor', name: 'Cursor integration' },
      { kind: 'codex', name: 'Codex integration' },
    ] as const) {
      const adapter = this.adapterRegistry.get(item.kind);
      if (!adapter) {
        leadIntegrations.push({
          name: item.name,
          status: 'fail',
          detail: `${item.kind} adapter is not registered — council/review cannot use it`,
        });
        continue;
      }
      const result = await adapter.test();
      leadIntegrations.push({
        name: item.name,
        status: result.ok ? 'ok' : 'fail',
        detail: result.ok ? result.version : result.error,
      });
    }
    let learningDetail = 'no docs/solutions notes yet';
    let learningStatus: DoctorCheck['status'] = 'skip';
    try {
      const solutions = path.join(this.cwd, 'docs', 'solutions');
      const names = (await fs.readdir(solutions)).filter((name) => name.endsWith('.md'));
      if (names.length === 0) {
        learningStatus = 'skip';
        learningDetail = 'no docs/solutions notes yet';
      } else {
        let stale = 0;
        for (const name of names) {
          const text = await fs.readFile(path.join(solutions, name), 'utf8');
          if (/^status:\s*stale\b/im.test(text)) stale += 1;
        }
        learningStatus = 'ok';
        learningDetail = stale > 0
          ? `${names.length - stale} current / ${stale} stale — run ce-compound-refresh (plan/council already skip stale)`
          : `${names.length} learning(s) current`;
      }
    } catch {
      // directory missing is skip, not fail
    }
    return [
      ...leadIntegrations,
      {
        name: 'learnings',
        status: learningStatus,
        detail: learningDetail,
      },
      await this.checkFile('compound.yml', compound, 'CE methodology (ORCH stays the scheduler)'),
      await this.checkFile('admission rule', admissionRule, 'watcher-owned creates; workers never self-approve'),
      await this.checkFile('cursor-review.yml', cursorReview, 'add repo secret CURSOR_API_KEY for trusted same-repo PRs'),
      await this.checkFile('wiki-preview.yml', wikiPreview, 'PR wiki preview — generate only, never publish'),
      await this.checkFile('wiki-publish.yml', wikiPublish, 'default-branch canonical wiki publish'),
      conventionsFile,
      {
        name: 'github origin',
        status: /github\.com/i.test(origin) ? 'ok' : origin ? 'skip' : 'fail',
        detail: origin || 'no origin remote — PRs and wiki publish need a GitHub/GitLab remote',
      },
    ];
  }

  private async checkFile(name: string, filePath: string, okDetail: string): Promise<DoctorCheck> {
    try {
      await fs.access(filePath);
      return { name, status: 'ok', detail: okDetail };
    } catch {
      return { name, status: 'fail', detail: `missing ${path.relative(this.cwd, filePath)}` };
    }
  }

  private async gitOrigin(): Promise<string> {
    try {
      const { stdout } = await execFileAsync('git', ['config', '--get', 'remote.origin.url'], { cwd: this.cwd });
      return stdout.trim();
    } catch {
      return '';
    }
  }

  private async checkGitRepo(): Promise<DoctorCheck> {
    try {
      await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: this.cwd });
      return { name: 'git repo', status: 'ok', detail: 'git repository detected' };
    } catch {
      return {
        name: 'git repo',
        status: 'fail',
        detail: 'not a git repository — worktree/isolated modes will fail. Run: git init',
      };
    }
  }
}
