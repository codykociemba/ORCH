/**
 * Detect GitHub vs GitLab from git remotes / CI env. Never guess from hostname alone
 * when CI variables are present.
 */

export type WikiHost = 'github' | 'gitlab' | 'unknown';

export interface WikiProviderDetection {
  host: WikiHost;
  owner?: string;
  repo?: string;
  origin?: string;
}

export function detectWikiProvider(input: {
  origin?: string;
  githubServerUrl?: string;
  gitlabProjectUrl?: string;
  ci?: boolean;
  remotes?: string[];
  configured?: 'github' | 'gitlab' | 'auto';
}): WikiProviderDetection {
  if (input.configured === 'github' || input.configured === 'gitlab') {
    const origin = input.origin ?? input.gitlabProjectUrl ?? '';
    return origin ? parseRemote(origin, input.configured) : { host: input.configured };
  }
  const remoteHosts = new Set(
    (input.remotes ?? []).map((remote) => parseRemote(remote).host).filter((host) => host !== 'unknown'),
  );
  if (remoteHosts.has('github') && remoteHosts.has('gitlab')) {
    return { host: 'unknown', origin: input.origin };
  }
  if (input.gitlabProjectUrl && input.githubServerUrl && input.origin) {
    const fromOrigin = parseRemote(input.origin);
    const fromGitlab = parseRemote(input.gitlabProjectUrl, 'gitlab');
    if (fromOrigin.host === 'github' && fromGitlab.host === 'gitlab') {
      return { host: 'unknown', origin: input.origin };
    }
  }
  if (input.gitlabProjectUrl) {
    return parseRemote(input.gitlabProjectUrl, 'gitlab');
  }
  if (input.githubServerUrl && input.origin) {
    return parseRemote(input.origin, 'github');
  }
  if (input.origin) {
    return parseRemote(input.origin);
  }
  if (remoteHosts.size === 1) {
    const host = [...remoteHosts][0] as WikiHost;
    return { host };
  }
  return { host: 'unknown' };
}

export function parseRemote(origin: string, forced?: WikiHost): WikiProviderDetection {
  const normalized = origin.trim();
  const github = /github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?/i.exec(normalized);
  const gitlab = /gitlab\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?/i.exec(normalized);
  const generic = /[:/]([^/]+)\/([^/.]+)(?:\.git)?$/.exec(normalized.replace(/\/+$/, ''));

  if (forced === 'github' || github) {
    const match = github ?? generic;
    return { host: 'github', owner: match?.[1], repo: match?.[2], origin: normalized };
  }
  if (forced === 'gitlab' || gitlab) {
    const match = gitlab ?? generic;
    return { host: 'gitlab', owner: match?.[1], repo: match?.[2], origin: normalized };
  }
  if (/gitlab/i.test(normalized)) {
    return { host: 'gitlab', owner: generic?.[1], repo: generic?.[2], origin: normalized };
  }
  if (/github/i.test(normalized)) {
    return { host: 'github', owner: generic?.[1], repo: generic?.[2], origin: normalized };
  }
  return { host: 'unknown', origin: normalized };
}

export function isDefaultBranch(current: string, defaultBranch: string): boolean {
  return current.replace(/^refs\/heads\//, '') === defaultBranch.replace(/^refs\/heads\//, '');
}

export const ORCH_WIKI_MARKER = '<!-- orch-wiki:generated';

export function githubWikiRemote(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.wiki.git`;
}

/** CI may set a token; locally prefer `gh auth token` so users do not paste GITHUB_TOKEN. */
export function envGitHubToken(): string {
  return process.env['ORCH_GITHUB_WIKI_TOKEN'] ?? process.env['GITHUB_TOKEN'] ?? '';
}

export function withGitHubToken(remote: string, token: string): string {
  if (!token) return remote;
  return remote.replace('https://', `https://x-access-token:${token}@`);
}

export function gitlabWikiApiBase(): string {
  return (process.env['CI_API_V4_URL'] ?? process.env['GITLAB_API_URL'] ?? 'https://gitlab.com/api/v4').replace(/\/+$/, '');
}

export function gitlabProjectPath(owner: string, repo: string): string {
  return encodeURIComponent(`${owner}/${repo}`);
}

export function isOrchWikiPage(content: string): boolean {
  return content.includes(ORCH_WIKI_MARKER);
}

export function wrapWikiPage(body: string, sha: string): string {
  const stripped = body.replace(/^<!-- orch-wiki:generated[^>]*-->\s*/m, '');
  return `${ORCH_WIKI_MARKER} sha=${sha} -->\n${stripped}`;
}

/** GitNexus writes overview.md; GitHub wiki home page is Home.md. */
export function generatedWikiPageName(file: string): string | null {
  const base = file.replace(/\\/g, '/').split('/').pop() ?? '';
  if (!base.endsWith('.md')) return null;
  if (base === 'overview.md') return 'Home.md';
  return base;
}

export interface WikiSyncPlan {
  write: Array<{ name: string; body: string }>;
  remove: string[];
  preserved: string[];
}

export function planWikiSync(input: {
  generated: Array<{ name: string; body: string }>;
  remote: Array<{ name: string; body: string }>;
  sha: string;
}): WikiSyncPlan {
  const write: WikiSyncPlan['write'] = [];
  const generatedNames = new Set<string>();
  for (const page of input.generated) {
    const name = generatedWikiPageName(page.name);
    if (!name) continue;
    generatedNames.add(name);
    write.push({ name, body: wrapWikiPage(page.body, input.sha) });
  }

  const preserved: string[] = [];
  const remove: string[] = [];
  for (const page of input.remote) {
    if (generatedNames.has(page.name)) continue;
    if (isOrchWikiPage(page.body)) remove.push(page.name);
    else preserved.push(page.name);
  }
  return { write, remove, preserved };
}
