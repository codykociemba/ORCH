import { describe, it, expect } from 'vitest';
import {
  detectWikiProvider,
  generatedWikiPageName,
  githubWikiBootstrapUrl,
  githubWikiRemote,
  isLocalOnlyWikiPage,
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
    expect(gitlabWikiApiBase('https://git.internal.net/acme/orch.git')).toBe('https://git.internal.net/api/v4');
    expect(gitlabWikiApiBase('git@git.internal.net:acme/orch.git')).toBe('https://git.internal.net/api/v4');
    expect(gitlabWikiApiBase(undefined, 'https://git.company/api/v4/')).toBe('https://git.company/api/v4');
    const previous = process.env['CI_API_V4_URL'];
    process.env['CI_API_V4_URL'] = 'https://git.example.com/api/v4/';
    expect(gitlabWikiApiBase('https://git.internal.net/acme/orch.git')).toBe('https://git.example.com/api/v4');
    if (previous === undefined) delete process.env['CI_API_V4_URL'];
    else process.env['CI_API_V4_URL'] = previous;
  });

  it('maps GitNexus overview.md to GitHub Home.md', () => {
    expect(generatedWikiPageName('overview.md')).toBe('Home.md');
    expect(githubWikiRemote('codykociemba', 'ORCH')).toBe('https://github.com/codykociemba/ORCH.wiki.git');
    expect(githubWikiBootstrapUrl('codykociemba', 'ORCH')).toBe('https://github.com/codykociemba/ORCH/wiki/_new');
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
    expect(plan.write[0]?.body).toContain('orch:gitnexus-generated');
    expect(plan.write[0]?.body).toContain('source-sha: abc1234');
    expect(plan.write[0]?.body).toContain('generated-at:');
    expect(plan.write[0]?.body).toContain('# Overview');
    expect(plan.remove).toEqual(['Stale.md']);
    expect(plan.preserved).toEqual(['Notes.md']);
  });

  it('removes unmarked human pages only in full-ownership mode', () => {
    const generated = [{ name: 'overview.md', body: '# Overview' }];
    const remote = [
      { name: 'Home.md', body: '<!-- orch:gitnexus-generated -->\nold' },
      { name: 'Notes.md', body: 'human notes' },
    ];
    const generatedOnly = planWikiSync({ sha: 'abc1234', generated, remote });
    expect(generatedOnly.preserved).toEqual(['Notes.md']);
    const full = planWikiSync({ sha: 'abc1234', generated, remote, ownership: 'full' });
    expect(full.remove).toContain('Notes.md');
    expect(full.preserved).toEqual([]);
  });

  it('does not publish local-only implementation spec pages', () => {
    expect(isLocalOnlyWikiPage(
      'project-documentation-build-scripts-orch-compound-linear-cou.md',
      '# ORCH_COMPOUND_LINEAR_COUNCIL_IMPLEMENTATION_SPEC.md',
    )).toBe(true);
    const plan = planWikiSync({
      sha: 'abc1234',
      generated: [
        { name: 'overview.md', body: '# Overview' },
        {
          name: 'project-documentation-build-scripts-orch-gitnexus-code-admis.md',
          body: '# ORCH_GITNEXUS_CODE_ADMISSION_ADDENDUM.md\nlocal only',
        },
      ],
      remote: [
        {
          name: 'project-documentation-build-scripts-orch-gitnexus-code-admis.md',
          body: '<!-- orch-wiki:generated sha=old -->\nleaked spec',
        },
      ],
    });
    expect(plan.write.map((page) => page.name)).toEqual(['Home.md']);
    expect(plan.remove).toEqual(['project-documentation-build-scripts-orch-gitnexus-code-admis.md']);
  });

  it('embeds a GitHub token only when one is provided', () => {
    const remote = githubWikiRemote('acme', 'orch');
    expect(withGitHubToken(remote, '')).toBe(remote);
    expect(withGitHubToken(remote, 'gho_test')).toBe(
      'https://x-access-token:gho_test@github.com/acme/orch.wiki.git',
    );
  });
});
