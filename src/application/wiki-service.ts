/**
 * GitNexus wiki generate / preview / publish.
 * Canonical publish is default-branch only unless a human passes --force.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitnexusBin, gitnexusCliEnv, resolveGitnexusSpawn } from '../infrastructure/code-intelligence/cli-runner.js';
import { detectWikiProvider, isDefaultBranch, type WikiHost } from '../infrastructure/wiki/provider.js';
import { OrchestryError } from '../domain/errors.js';

const execFileAsync = promisify(execFile);

export class WikiPublishError extends OrchestryError {
  constructor(message: string, hint?: string) {
    super(message, 1, hint);
    this.name = 'WikiPublishError';
  }
}

export interface WikiStatus {
  host: WikiHost;
  current_branch: string;
  default_branch: string;
  can_publish: boolean;
  origin?: string;
}

export class WikiService {
  constructor(private readonly projectRoot: string) {}

  async status(): Promise<WikiStatus> {
    const origin = await this.git(['config', '--get', 'remote.origin.url']).catch(() => '');
    const current = await this.git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD');
    const defaultBranch = await this.detectDefaultBranch();
    const detection = detectWikiProvider({
      origin,
      githubServerUrl: process.env['GITHUB_SERVER_URL'],
      gitlabProjectUrl: process.env['CI_PROJECT_URL'],
    });
    return {
      host: detection.host,
      current_branch: current,
      default_branch: defaultBranch,
      can_publish: isDefaultBranch(current, defaultBranch),
      origin,
    };
  }

  async generate(args: string[] = []): Promise<{ stdout: string; stderr: string }> {
    return this.runWiki(['generate', ...args]);
  }

  async preview(args: string[] = []): Promise<{ stdout: string; stderr: string }> {
    return this.runWiki(['preview', ...args]);
  }

  async publish(opts: { force?: boolean; trustedDefaultBranch?: boolean } = {}): Promise<{ stdout: string; stderr: string }> {
    const status = await this.status();
    if (!status.can_publish && !opts.force && !opts.trustedDefaultBranch) {
      throw new WikiPublishError(
        `Refusing canonical wiki publication:\ncurrent branch ${status.current_branch} does not match default branch ${status.default_branch}.`,
        'Use --force only if you intentionally want this.',
      );
    }
    return this.runWiki(['publish']);
  }

  private async runWiki(args: string[]): Promise<{ stdout: string; stderr: string }> {
    try {
      const invoked = resolveGitnexusSpawn(gitnexusBin(), ['wiki', ...args]);
      const { stdout, stderr } = await execFileAsync(invoked.command, invoked.args, {
        cwd: this.projectRoot,
        env: gitnexusCliEnv(),
        timeout: 300_000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      });
      return { stdout, stderr };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new WikiPublishError(`gitnexus wiki ${args[0] ?? ''} failed`, message);
    }
  }

  private async detectDefaultBranch(): Promise<string> {
    const symbolic = await this.git(['symbolic-ref', 'refs/remotes/origin/HEAD']).catch(() => '');
    const named = symbolic.replace(/^refs\/remotes\/origin\//, '').trim();
    if (named) return named;
    return 'main';
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, { cwd: this.projectRoot, windowsHide: true });
    return stdout.trim();
  }
}
