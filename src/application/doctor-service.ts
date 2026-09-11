/**
 * Doctor service — diagnostics and health checks.
 *
 * Checks adapter availability, system dependencies, project state.
 */

import type { AdapterRegistry } from '../infrastructure/adapters/registry.js';
import type { IProcessManager } from '../infrastructure/process/process-manager.js';
import { detectWslGitnexus, gitnexusBin, resolveGitnexusSpawn } from '../infrastructure/code-intelligence/cli-runner.js';
import { resolveLinearApiKey } from '../infrastructure/integrations/linear/linear-issue-tracker.js';
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
    checks.push(await this.checkWiki());
    checks.push(await this.checkGitHubCli());
    checks.push(this.checkLinearAuth());

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
    const binary = await this.checkGitNexus();
    const checks: DoctorCheck[] = [binary];
    if (binary.status !== 'ok') {
      checks.push({
        name: 'gitnexus index',
        status: 'skip',
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
      const currentDetail = status.index_commit
        ?? (status.incomplete_reasons.join('; ') || 'index not current');
      checks.push({
        name: 'gitnexus current',
        status: status.current ? 'ok' : 'fail',
        detail: detectWslGitnexus()
          ? `${currentDetail} — using WSL2 GitNexus`
          : process.platform === 'win32'
            ? `${currentDetail} — native Windows is best-effort; prefer GITNEXUS_BIN=wsl`
            : currentDetail,
      });
    } catch (err) {
      checks.push({
        name: 'gitnexus index',
        status: 'fail',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    checks.push({
      name: 'gitnexus detect_changes worktree',
      status: 'ok',
      detail: 'Adapter requires an explicit worktree and passes it to MCP (see gitnexus-adapter tests)',
    });
    return checks;
  }

  private async checkWiki(): Promise<DoctorCheck> {
    try {
      const { WikiService } = await import('./wiki-service.js');
      const status = await new WikiService(this.cwd).status({ probeRemote: false });
      if (status.host === 'unknown') {
        return {
          name: 'wiki',
          status: 'fail',
          detail: 'Ambiguous or unknown wiki host — set wiki.provider in .orch/workflow.yml',
        };
      }
      return {
        name: 'wiki',
        status: 'ok',
        detail: `${status.host} · ${status.pages_generated} generated page(s) — run orch wiki status to probe remote bootstrap`,
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
      detail: 'Optional behavioral nudge (https://github.com/DietrichGebert/ponytail). Not an enforcement gate.',
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

  private checkLinearAuth(): DoctorCheck {
    if (resolveLinearApiKey()) {
      return {
        name: 'linear',
        status: 'ok',
        detail: process.env['LINEAR_API_KEY']
          ? 'LINEAR_API_KEY is set'
          : 'Linear credential stored (~/.orchestry/linear.token)',
      };
    }
    return {
      name: 'linear',
      status: 'skip',
      detail: 'Run `orch integration login` (Linear desktop / Cursor MCP cannot authenticate this CLI).',
    };
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
