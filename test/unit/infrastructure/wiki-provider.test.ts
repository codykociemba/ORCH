import { describe, it, expect } from 'vitest';
import {
  detectWikiProvider,
  generatedWikiPageName,
  githubWikiRemote,
  gitlabProjectPath,
  gitlabWikiApiBase,
  isDefaultBranch,
  parseRemote,
  planWikiSync,
  withGitHubToken,
} from '../../../src/infrastructure/wiki/provider.js';

describe('wiki provider detection', () => {
  it('parses GitHub HTTPS', () => {
    expect(parseRemote('https://github.com/oxgeneral/ORCH.git').host).toBe('github');
  });

  it('parses GitHub SSH', () => {
    const detected = parseRemote('git@github.com:oxgeneral/ORCH.git');
    expect(detected.host).toBe('github');
    expect(detected.owner).toBe('oxgeneral');
    expect(detected.repo).toBe('ORCH');
  });

  it('parses GitLab HTTPS', () => {
    expect(parseRemote('https://gitlab.com/symbaventures/orch.git').host).toBe('gitlab');
  });

  it('parses GitLab SSH', () => {
    expect(parseRemote('git@gitlab.com:symbaventures/orch.git').host).toBe('gitlab');
  });

  it('fails closed when GitHub and GitLab remotes both exist', () => {
    const detected = detectWikiProvider({
      origin: 'https://github.com/acme/orch.git',
      remotes: [
        'https://github.com/acme/orch.git',
        'https://gitlab.com/acme/orch.git',
      ],
    });
    expect(detected.host).toBe('unknown');
  });

  it('honors an explicit wiki.provider when remotes are mixed', () => {
    const detected = detectWikiProvider({
      origin: 'https://github.com/acme/orch.git',
      remotes: [
        'https://github.com/acme/orch.git',
        'https://gitlab.com/acme/orch.git',
      ],
      configured: 'github',
    });
    expect(detected.host).toBe('github');
  });

  it('fails closed when GitHub and GitLab CI identities both exist', () => {
    const detected = detectWikiProvider({
      origin: 'https://github.com/example/fork.git',
      githubServerUrl: 'https://github.com',
      gitlabProjectUrl: 'https://gitlab.com/symbaventures/orch',
    });
    expect(detected.host).toBe('unknown');
  });

  it('prefers GitLab CI project URL', () => {
    const detected = detectWikiProvider({
      origin: 'https://github.com/example/fork.git',
      gitlabProjectUrl: 'https://gitlab.com/symbaventures/orch',
    });
    expect(detected.host).toBe('gitlab');
  });

  it('default-branch guard', () => {
    expect(isDefaultBranch('feature/ENG-142', 'main')).toBe(false);
    expect(isDefaultBranch('refs/heads/main', 'main')).toBe(true);
  });

  it('builds GitLab wiki API paths', () => {
    expect(gitlabProjectPath('acme', 'orch')).toBe('acme%2Forch');
    expect(gitlabWikiApiBase()).toMatch(/\/api\/v4$/);
  });

  it('maps GitNexus overview.md to GitHub Home.md', () => {
    expect(generatedWikiPageName('overview.md')).toBe('Home.md');
    expect(githubWikiRemote('codykociemba', 'ORCH')).toBe('https://github.com/codykociemba/ORCH.wiki.git');
  });

  it('syncs generated pages, deletes stale ORCH pages, preserves human pages', () => {
    const plan = planWikiSync({
      sha: 'abc1234',
      generated: [{ name: 'overview.md', body: '# Overview' }],
      remote: [
        { name: 'Home.md', body: '<!-- orch-wiki:generated sha=old -->\nold' },
        { name: 'Stale.md', body: '<!-- orch-wiki:generated sha=old -->\nstale' },
        { name: 'Notes.md', body: 'human notes' },
      ],
    });
    expect(plan.write[0]?.name).toBe('Home.md');
    expect(plan.write[0]?.body).toContain('orch-wiki:generated');
    expect(plan.write[0]?.body).toContain('# Overview');
    expect(plan.remove).toEqual(['Stale.md']);
    expect(plan.preserved).toEqual(['Notes.md']);
  });

  it('embeds a GitHub token only when one is provided', () => {
    const remote = githubWikiRemote('acme', 'orch');
    expect(withGitHubToken(remote, '')).toBe(remote);
    expect(withGitHubToken(remote, 'gho_test')).toBe(
      'https://x-access-token:gho_test@github.com/acme/orch.wiki.git',
    );
  });
});
