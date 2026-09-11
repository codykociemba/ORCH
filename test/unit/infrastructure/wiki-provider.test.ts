import { describe, it, expect } from 'vitest';
import { detectWikiProvider, isDefaultBranch, parseRemote } from '../../../src/infrastructure/wiki/provider.js';

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
});
