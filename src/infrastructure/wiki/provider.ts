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
}): WikiProviderDetection {
  if (input.gitlabProjectUrl) {
    return parseRemote(input.gitlabProjectUrl, 'gitlab');
  }
  if (input.githubServerUrl && input.origin) {
    return parseRemote(input.origin, 'github');
  }
  if (input.origin) {
    return parseRemote(input.origin);
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
