/**
 * GitNexus wiki generate / preview / publish.
 * GitNexus 1.6 command is `gitnexus wiki` (generate). Preview stays local.
 * Canonical publish syncs marked pages to GitHub/GitLab wiki and is
 * default-branch only unless a human passes --force.
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { gitnexusBinForWiki, gitnexusCliEnv, resolveGitnexusSpawn } from '../infrastructure/code-intelligence/cli-runner.js';
import {
  detectWikiProvider,
  envGitHubToken,
  githubWikiBootstrapUrl,
  githubWikiRemote,
  gitlabProjectPath,
  gitlabWikiApiBase,
  isDefaultBranch,
  parseRemote,
  planWikiSync,
  withGitHubToken,
  type WikiHost,
} from '../infrastructure/wiki/provider.js';
import { OrchestryError } from '../domain/errors.js';
import type { WikiEvidence } from '../domain/evidence.js';
import { WorkflowConfigStore } from '../infrastructure/storage/workflow-config-store.js';
import type { WorkflowConfig } from '../domain/workflow-config.js';

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
  owner?: string;
  repo?: string;
  bootstrap_required: boolean;
  bootstrap_url?: string;
  wiki_dir: string;
  pages_generated: number;
  source_sha?: string;
  index_current: boolean;
}

export interface WikiRunResult {
  stdout: string;
  stderr: string;
  bootstrap_required?: boolean;
  pages_published?: number;
}

export type WikiExec = (
  command: string,
  args: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number },
) => Promise<{ stdout: string; stderr: string }>;

export class WikiService {
  constructor(
    private readonly projectRoot: string,
    private readonly exec: WikiExec = defaultExec,
    private readonly http: typeof fetch = fetch,
    private readonly indexCurrent: () => Promise<boolean> = () => probeGitNexusIndexCurrent(projectRoot),
  ) {}

  wikiDir(): string {
    return path.join(this.projectRoot, '.gitnexus', 'wiki');
  }

  async status(opts: { probeRemote?: boolean } = {}): Promise<WikiStatus> {
    const origin = await resolvePublishRemote((args) => this.git(args));
    const remoteList = await this.git(['remote', '-v']).catch(() => '');
    const remotes = remoteList
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[1])
      .filter((item): item is string => Boolean(item));
    const current = await this.git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'HEAD');
    const sourceSha = await this.git(['rev-parse', 'HEAD']).catch(() => undefined);
    const defaultBranch = await this.detectDefaultBranch();
    const workflow = await new WorkflowConfigStore(this.projectRoot).read();
    const explicit = workflow?.wiki?.provider;
    const originHost = parseRemote(origin).host;
    const detection = detectWikiProvider({
      origin,
      remotes,
      configured: explicit === 'github' || explicit === 'gitlab'
        ? explicit
        : inferConfiguredHost(origin, remotes, workflow),
      githubServerUrl: originHost === 'gitlab' ? undefined : process.env['GITHUB_SERVER_URL'],
      gitlabProjectUrl: originHost === 'github' ? undefined : process.env['CI_PROJECT_URL'],
    });
    const pages = await this.listGeneratedPages();
    const index_current = await this.indexCurrent();
    const shouldProbe = opts.probeRemote !== false;
    const bootstrap = shouldProbe && detection.host === 'github' && detection.owner && detection.repo
      ? !(await this.githubWikiExists(detection.owner, detection.repo))
      : false;
    return {
      host: detection.host,
      current_branch: current,
      default_branch: defaultBranch,
      can_publish: isDefaultBranch(current, defaultBranch),
      origin,
      owner: detection.owner,
      repo: detection.repo,
      bootstrap_required: bootstrap,
      bootstrap_url: bootstrap && detection.owner && detection.repo
        ? githubWikiBootstrapUrlFor(detection.owner, detection.repo, origin)
        : undefined,
      wiki_dir: this.wikiDir(),
      pages_generated: pages.length,
      source_sha: sourceSha,
      index_current,
    };
  }

  async evidence(mode: WikiEvidence['mode']): Promise<WikiEvidence> {
    const status = await this.status();
    const index_current = status.index_current;
    return {
      enabled: true,
      provider: status.host === 'unknown' ? undefined : status.host,
      mode,
      source_sha: status.source_sha ?? '',
      index_current,
      status: !index_current
        ? 'failed'
        : status.bootstrap_required
          ? 'bootstrap_required'
          : (status.pages_generated > 0 ? 'passed' : 'skipped'),
      pages_generated: status.pages_generated,
      pages_published: mode === 'canonical-publish' && !status.bootstrap_required && index_current
        ? status.pages_generated
        : undefined,
      failed_modules: [],
      canonical_wiki_url: status.bootstrap_required
        ? undefined
        : canonicalWikiHomeUrl(status.host, status.owner, status.repo, status.origin),
      summary: [
        status.bootstrap_required ? 'Remote publication: one-time GitHub wiki bootstrap required' : '',
        !index_current ? 'GitNexus index is not current — wiki evidence is not architectural truth' : '',
      ].filter(Boolean).join('; ') || undefined,
    };
  }

  /** GitNexus 1.6: `gitnexus wiki` generates `.gitnexus/wiki`. There is no `wiki generate` subcommand. */
  async generate(args: string[] = []): Promise<WikiRunResult> {
    let current = await this.indexCurrent();
    if (!current) {
      try {
        const invoked = resolveGitnexusSpawn(gitnexusBinForWiki(args), ['analyze', '--index-only']);
        await this.exec(invoked.command, invoked.args, {
          cwd: this.projectRoot,
          env: gitnexusCliEnv(),
          timeout: 300_000,
        });
        current = await this.indexCurrent();
      } catch {
        current = await this.indexCurrent();
      }
    }
    const workflow = await new WorkflowConfigStore(this.projectRoot).read();
    const generateArgs = wikiGenerateArgs(workflow, args);
    const argv = current || args.includes('--force')
      ? generateArgs
      : generateArgs.filter((item) => item !== '--force');
    const result = await this.runGitnexusWiki(argv, 1_200_000);
    if (current) return result;
    return {
      ...result,
      stdout: [
        result.stdout,
        'GitNexus index is not current — generated wiki is not architectural truth. Run `orch code status` / analyze before relying on it.',
        generateArgs.includes('--force') && !args.includes('--force')
          ? 'Refused automatic --force while the index is stale.'
          : '',
      ].filter(Boolean).join('\n'),
    };
  }

  /** Local generate only — never publishes the provider wiki. */
  async preview(args: string[] = []): Promise<WikiRunResult> {
    return this.generate(args);
  }

  async publish(opts: { force?: boolean; trustedDefaultBranch?: boolean } = {}): Promise<WikiRunResult> {
    const status = await this.status();
    if (!status.can_publish && !opts.force && !opts.trustedDefaultBranch) {
      throw new WikiPublishError(
        `Refusing canonical wiki publication:\ncurrent branch ${status.current_branch} does not match default branch ${status.default_branch}.`,
        'Use --force only if you intentionally want this.',
      );
    }
    if (status.bootstrap_required) {
      if (status.host === 'github' && status.owner && status.repo) {
        const created = await this.tryBootstrapGitHubWiki(status.owner, status.repo);
        if (created) {
          const published = await this.publishGitHub(status);
          return {
            stdout: `Bootstrapped GitHub wiki and published ${published} ORCH wiki page(s)`,
            stderr: '',
            pages_published: published,
          };
        }
      }
      return {
        stdout: [
          'BOOTSTRAP_REQUIRED',
          'GitHub will not serve OWNER/REPO.wiki.git until one page exists.',
          'ORCH tried to enable the repository Wiki and push Home.md.',
          'If that failed, enable the Wiki if needed and create the first page once:',
          status.bootstrap_url ? status.bootstrap_url : '',
          'After that, ORCH will own/update generated wiki pages automatically.',
        ].filter(Boolean).join('\n'),
        stderr: '',
        bootstrap_required: true,
        pages_published: 0,
      };
    }
    if (status.host === 'github' && status.owner && status.repo) {
      const published = await this.publishGitHub(status);
      return {
        stdout: `Published ${published} ORCH wiki page(s) to GitHub`,
        stderr: '',
        pages_published: published,
      };
    }
    if (status.host === 'gitlab' && status.owner && status.repo) {
      const published = await this.publishGitLab(status);
      return {
        stdout: `Published ${published} ORCH wiki page(s) to GitLab`,
        stderr: '',
        pages_published: published,
      };
    }
    throw new WikiPublishError('Cannot detect GitHub or GitLab wiki host from origin');
  }

  private async publishGitHub(status: WikiStatus): Promise<number> {
    if (!(await this.indexCurrent())) {
      throw new WikiPublishError(
        'GitNexus index is not current — refusing canonical wiki publish',
        'Run analyze --index-only, then orch wiki generate and orch wiki publish',
      );
    }
    const owner = status.owner!;
    const repo = status.repo!;
    const sha = status.source_sha ?? 'unknown';
    const generated = await this.listGeneratedPages();
    if (generated.length === 0) {
      throw new WikiPublishError('No generated wiki pages under .gitnexus/wiki', 'Run orch wiki generate first');
    }
    const remote = githubWikiRemoteFor(owner, repo, status.origin);
    const authed = await this.resolveGitHubWikiRemote(remote);
    const cloneDir = path.join(this.projectRoot, '.orchestry', 'wiki-publish');
    await fs.rm(cloneDir, { recursive: true, force: true });
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.exec('git', ['clone', '--depth', '1', authed, cloneDir], { cwd: this.projectRoot });
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        await fs.rm(cloneDir, { recursive: true, force: true });
        if (attempt >= 2) break;
      }
    }
    if (lastErr) {
      throw lastErr instanceof Error ? lastErr : new WikiPublishError('GitHub wiki clone failed after retries');
    }
    const remotePages = await readMarkdownPages(cloneDir);
    const workflow = await new WorkflowConfigStore(this.projectRoot).read();
    const plan = planWikiSync({ generated, remote: remotePages, sha, ownership: wikiOwnership(workflow) });
    for (const name of plan.remove) {
      await fs.rm(path.join(cloneDir, name), { force: true });
    }
    for (const page of plan.write) {
      await fs.writeFile(path.join(cloneDir, page.name), page.body, 'utf8');
    }
    await this.gitIn(cloneDir, ['add', '-A']);
    const dirty = await this.gitIn(cloneDir, ['status', '--porcelain']);
    if (!dirty) return plan.write.length;
    await this.gitIn(cloneDir, ['config', 'user.email', 'orch@local']);
    await this.gitIn(cloneDir, ['config', 'user.name', 'ORCH']);
    await this.gitIn(cloneDir, ['commit', '-m', `docs(wiki): sync GitNexus docs for ${sha.slice(0, 7)}`]);
    lastErr = undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.exec('git', ['push', 'origin', 'HEAD'], { cwd: cloneDir });
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        if (attempt >= 2) break;
      }
    }
    if (lastErr) {
      throw lastErr instanceof Error ? lastErr : new WikiPublishError('GitHub wiki push failed after retries');
    }
    return plan.write.length;
  }

  private async publishGitLab(status: WikiStatus): Promise<number> {
    if (!(await this.indexCurrent())) {
      throw new WikiPublishError(
        'GitNexus index is not current — refusing canonical wiki publish',
        'Run analyze --index-only, then orch wiki generate and orch wiki publish',
      );
    }
    const workflowForToken = await new WorkflowConfigStore(this.projectRoot).read();
    const token = wikiNamedToken(workflowForToken, 'gitlab')
      || process.env['ORCH_GITLAB_WIKI_TOKEN']
      || process.env['GITLAB_TOKEN']
      || process.env['CI_JOB_TOKEN']
      || '';
    if (!token) {
      throw new WikiPublishError(
        'GitLab wiki publish needs ORCH_GITLAB_WIKI_TOKEN or GITLAB_TOKEN',
        'Set the token, then retry orch wiki publish on the default branch.',
      );
    }
    const generated = await this.listGeneratedPages();
    if (generated.length === 0) {
      throw new WikiPublishError('No generated wiki pages under .gitnexus/wiki', 'Run orch wiki generate first');
    }
    const sha = status.source_sha ?? 'unknown';
    const project = gitlabProjectPath(status.owner!, status.repo!);
    const extra = workflowForToken?.wiki as { gitlab?: { api_url?: string } } | undefined;
    const base = `${gitlabWikiApiBase(status.origin, extra?.gitlab?.api_url)}/projects/${project}/wikis`;
    const jobToken = Boolean(process.env['CI_JOB_TOKEN']) && !process.env['ORCH_GITLAB_WIKI_TOKEN'] && !process.env['GITLAB_TOKEN'];
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(jobToken ? { 'JOB-TOKEN': token } : { 'PRIVATE-TOKEN': token }),
    };
    const rawHttp = this.http.bind(this);
    const http = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        const incoming = init?.signal;
        const onAbort = (): void => controller.abort();
        incoming?.addEventListener('abort', onAbort);
        try {
          const response = await rawHttp(input, { ...init, signal: controller.signal });
          if ((response.status === 429 || response.status >= 500) && attempt < 2) {
            await new Promise((resolve) => { setTimeout(resolve, 200 * (2 ** attempt)); });
            continue;
          }
          return response;
        } catch (err) {
          lastError = err;
          if (incoming?.aborted || attempt >= 2) break;
          await new Promise((resolve) => { setTimeout(resolve, 200 * (2 ** attempt)); });
        } finally {
          clearTimeout(timer);
          incoming?.removeEventListener('abort', onAbort);
        }
      }
      throw lastError instanceof Error ? lastError : new Error('GitLab wiki request failed after retries');
    }) as typeof fetch;
    const listed = await http(base, { headers });
    if (!listed.ok) {
      throw new WikiPublishError(
        `GitLab wiki list failed (${listed.status})`,
        'Confirm the Wiki feature is enabled and the token can write wikis.',
      );
    }
    const remoteRaw = await listed.json() as Array<{ slug?: string; title?: string; content?: string }>;
    const remote = remoteRaw.map((page) => ({
      name: `${page.slug ?? page.title ?? 'page'}.md`,
      body: page.content ?? '',
    }));
    const plan = planWikiSync({ generated, remote, sha, ownership: wikiOwnership(workflowForToken) });
    for (const page of plan.write) {
      const slug = page.name.replace(/\.md$/i, '');
      const title = slug === 'Home' ? 'home' : slug;
      const existing = remoteRaw.some((item) => (item.slug ?? item.title) === title || `${item.slug}.md` === page.name);
      const url = existing ? `${base}/${encodeURIComponent(title)}` : base;
      const response = await http(url, {
        method: existing ? 'PUT' : 'POST',
        headers,
        body: JSON.stringify({ title, content: page.body, format: 'markdown' }),
      });
      if (!response.ok) {
        throw new WikiPublishError(`GitLab wiki ${existing ? 'update' : 'create'} failed for ${title} (${response.status})`);
      }
    }
    for (const name of plan.remove) {
      const slug = name.replace(/\.md$/i, '');
      const response = await http(`${base}/${encodeURIComponent(slug)}`, { method: 'DELETE', headers });
      if (!response.ok && response.status !== 404) {
        throw new WikiPublishError(`GitLab wiki delete failed for ${slug} (${response.status})`);
      }
    }
    return plan.write.length;
  }

  /**
   * GitHub does not create OWNER/REPO.wiki.git until the first page exists.
   * A first `git push` of Home.md often creates that repo without the UI form.
   * If the push is rejected, fall back to the human _new URL.
   */
  private async tryBootstrapGitHubWiki(owner: string, repo: string): Promise<boolean> {
    let remote: string;
    try {
      remote = await this.resolveGitHubWikiRemote(githubWikiRemote(owner, repo));
    } catch {
      return false;
    }
    try {
      await this.exec('gh', ['api', '-X', 'PATCH', `repos/${owner}/${repo}`, '-f', 'has_wiki=true'], {
        cwd: this.projectRoot,
        timeout: 15_000,
      });
    } catch {
      // Wiki may already be enabled, or this token cannot change repo settings.
    }
    const dir = path.join(this.projectRoot, '.orchestry', 'wiki-bootstrap');
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    try {
      await this.exec('git', ['init'], { cwd: dir });
      await this.gitIn(dir, ['checkout', '-B', 'master']);
      await fs.writeFile(
        path.join(dir, 'Home.md'),
        [
          '# Home',
          '',
          'ORCH wiki bootstrap page. `orch wiki publish` replaces this with generated docs.',
          '',
          '<!-- orch:gitnexus-generated -->',
          '<!-- source-sha: bootstrap -->',
          '',
        ].join('\n'),
        'utf8',
      );
      await this.gitIn(dir, ['add', 'Home.md']);
      await this.gitIn(dir, ['config', 'user.email', 'orch@local']);
      await this.gitIn(dir, ['config', 'user.name', 'ORCH']);
      await this.gitIn(dir, ['commit', '-m', 'docs(wiki): bootstrap GitHub wiki']);
      await this.gitIn(dir, ['remote', 'add', 'origin', remote]);
      let pushed = false;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await this.exec('git', ['push', '-u', 'origin', 'HEAD:master'], { cwd: dir, timeout: 30_000 });
          pushed = true;
          break;
        } catch {
          if (attempt >= 2) break;
        }
      }
      return pushed;
    } catch {
      return false;
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async githubWikiExists(owner: string, repo: string): Promise<boolean> {
    try {
      const remote = await this.resolveGitHubWikiRemote(githubWikiRemote(owner, repo));
      await this.exec('git', ['ls-remote', remote, 'HEAD'], {
        cwd: this.projectRoot,
        timeout: 8_000,
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Prefer GITHUB_TOKEN in CI; locally use the logged-in GitHub CLI. Never require a pasted key. */
  private async resolveGitHubWikiRemote(remote: string): Promise<string> {
    const envToken = envGitHubToken();
    if (envToken) return withGitHubToken(remote, envToken);
    try {
      const { stdout } = await this.exec('gh', ['auth', 'token'], {
        cwd: this.projectRoot,
        timeout: 15_000,
      });
      const token = stdout.trim();
      if (token) return withGitHubToken(remote, token);
    } catch {
      throw new WikiPublishError(
        'GitHub wiki publish needs a logged-in GitHub CLI',
        'Run `gh auth login`. CI can still set GITHUB_TOKEN.',
      );
    }
    throw new WikiPublishError(
      'GitHub wiki publish needs a logged-in GitHub CLI',
      'Run `gh auth login`. CI can still set GITHUB_TOKEN.',
    );
  }

  private async listGeneratedPages(): Promise<Array<{ name: string; body: string }>> {
    return readMarkdownPages(this.wikiDir());
  }

  private async runGitnexusWiki(args: string[], timeoutMs = 300_000): Promise<WikiRunResult> {
    try {
      const invoked = resolveGitnexusSpawn(gitnexusBinForWiki(args), ['wiki', ...args]);
      const { stdout, stderr } = await this.exec(invoked.command, invoked.args, {
        cwd: this.projectRoot,
        env: gitnexusCliEnv(),
        timeout: timeoutMs,
      });
      return { stdout, stderr };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new WikiPublishError('gitnexus wiki failed', message);
    }
  }

  private async detectDefaultBranch(): Promise<string> {
    const symbolic = await this.git(['symbolic-ref', 'refs/remotes/origin/HEAD']).catch(() => '');
    const named = symbolic.replace(/^refs\/remotes\/origin\//, '').trim();
    if (named) return named;
    return 'main';
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await this.exec('git', args, { cwd: this.projectRoot });
    return stdout.trim();
  }

  private async gitIn(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await this.exec('git', args, { cwd });
    return stdout.trim();
  }
}

/** Addendum §52.1: prefer the branch push remote, then remote.pushDefault, then origin. */
async function resolvePublishRemote(
  git: (args: string[]) => Promise<string>,
): Promise<string> {
  const pushRef = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}']).catch(() => '');
  const fromPush = pushRef.replace(/^refs\/remotes\//, '').split('/')[0]?.trim();
  const pushDefault = (await git(['config', '--get', 'remote.pushDefault']).catch(() => '')).trim();
  const name = fromPush || pushDefault || 'origin';
  const url = (await git(['remote', 'get-url', '--push', name]).catch(() => '')).trim()
    || (await git(['remote', 'get-url', name]).catch(() => '')).trim()
    || (await git(['config', '--get', `remote.${name}.url`]).catch(() => '')).trim();
  if (url) return url;
  return (await git(['config', '--get', 'remote.origin.url']).catch(() => '')).trim();
}

/** Addendum §52.2: map enterprise / self-hosted hostnames onto GitHub or GitLab. */
function inferConfiguredHost(
  origin: string,
  remotes: string[],
  workflow: WorkflowConfig | null,
): 'github' | 'gitlab' | undefined {
  const extra = workflow?.wiki as {
    github_hosts?: string[];
    gitlab_hosts?: string[];
    repository?: { github_hosts?: string[]; gitlab_hosts?: string[] };
  } | undefined;
  const githubHosts = (extra?.repository?.github_hosts ?? extra?.github_hosts ?? [])
    .filter((host) => host && host.toLowerCase() !== 'github.com');
  const gitlabHosts = (extra?.repository?.gitlab_hosts ?? extra?.gitlab_hosts ?? [])
    .filter((host) => host && host.toLowerCase() !== 'gitlab.com');
  const urls = [origin, ...remotes];
  if (urls.some((url) => hostListed(url, githubHosts))) return 'github';
  if (urls.some((url) => hostListed(url, gitlabHosts))) return 'gitlab';
  return undefined;
}

function hostListed(url: string, hosts: string[]): boolean {
  return hosts.some((host) => host && url.toLowerCase().includes(host.toLowerCase()));
}

function wikiNamedToken(workflow: WorkflowConfig | null, provider: 'github' | 'gitlab'): string {
  const extra = workflow?.wiki as { github?: { token_env?: string }; gitlab?: { token_env?: string } } | undefined;
  const envName = provider === 'github' ? extra?.github?.token_env : extra?.gitlab?.token_env;
  return (envName && process.env[envName]) || '';
}

function wikiOwnership(workflow: WorkflowConfig | null): 'generated_pages' | 'full' {
  const wiki = workflow?.wiki as { ownership?: string; publish?: { ownership?: string } } | undefined;
  const raw = wiki?.publish?.ownership ?? wiki?.ownership;
  return raw === 'full' ? 'full' : 'generated_pages';
}

function gitWebHost(origin: string | undefined, fallback: string): string {
  const https = origin ? /https?:\/\/([^/@]+)/i.exec(origin)?.[1] : undefined;
  const ssh = origin ? /@([^:]+):/.exec(origin)?.[1] : undefined;
  return https || ssh || fallback;
}

function githubWikiRemoteFor(owner: string, repo: string, origin?: string): string {
  const host = gitWebHost(origin, 'github.com');
  if (host === 'github.com') return githubWikiRemote(owner, repo);
  return `https://${host}/${owner}/${repo}.wiki.git`;
}

function githubWikiBootstrapUrlFor(owner: string, repo: string, origin?: string): string {
  const host = gitWebHost(origin, 'github.com');
  if (host === 'github.com') return githubWikiBootstrapUrl(owner, repo);
  return `https://${host}/${owner}/${repo}/wiki/_new`;
}

function canonicalWikiHomeUrl(
  host: WikiHost,
  owner?: string,
  repo?: string,
  origin?: string,
): string | undefined {
  if (!owner || !repo) return undefined;
  if (host === 'github') return `https://${gitWebHost(origin, 'github.com')}/${owner}/${repo}/wiki`;
  if (host === 'gitlab') return `https://${gitWebHost(origin, 'gitlab.com')}/${owner}/${repo}/-/wikis/home`;
  return undefined;
}

function wikiGenerateArgs(workflow: WorkflowConfig | null, extra: string[] = []): string[] {
  const args: string[] = [];
  const llm = workflow?.wiki?.generator?.llm;
  let provider = process.env['GITNEXUS_WIKI_PROVIDER'] ?? (llm?.provider && llm.provider !== 'auto' ? llm.provider : undefined);
  const key = extra.includes('--api-key') ? undefined : process.env['GITNEXUS_WIKI_API_KEY'];
  const model = extra.includes('--model') ? undefined : (process.env['GITNEXUS_WIKI_MODEL'] ?? llm?.model);
  const language = extra.includes('--lang') ? undefined : workflow?.wiki?.generator?.language;
  const inCi = Boolean(process.env['CI'] || process.env['GITHUB_ACTIONS'] || process.env['VITEST']);
  if (!provider && !key && !inCi && !extra.includes('--provider')) {
    provider = 'claude';
  }
  if (provider && !extra.includes('--provider')) args.push('--provider', provider);
  if (key) args.push('--api-key', key);
  if (model) args.push('--model', model);
  if (language) args.push('--lang', language);
  if ((process.env['GITNEXUS_WIKI_FORCE'] === '1' || workflow?.wiki?.generator?.force) && !extra.includes('--force')) {
    args.push('--force');
  }
  return [...args, ...extra];
}

async function probeGitNexusIndexCurrent(projectRoot: string): Promise<boolean> {
  try {
    const { createGitNexusIntelligence } = await import('../infrastructure/code-intelligence/gitnexus-adapter.js');
    const handle = createGitNexusIntelligence(projectRoot);
    try {
      const status = await handle.intelligence.getRepositoryStatus({
        repository_root: projectRoot,
      });
      return status.available === true && status.current === true;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

async function readMarkdownPages(dir: string): Promise<Array<{ name: string; body: string }>> {
  try {
    const names = await fs.readdir(dir);
    const pages: Array<{ name: string; body: string }> = [];
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const body = await fs.readFile(path.join(dir, name), 'utf8');
      pages.push({ name, body });
    }
    return pages;
  } catch {
    return [];
  }
}

async function defaultExec(
  command: string,
  args: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(command, args, {
    cwd: opts?.cwd,
    env: opts?.env ?? process.env,
    timeout: opts?.timeout ?? 300_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  return { stdout: stdout.toString(), stderr: stderr.toString() };
}
