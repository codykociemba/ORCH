import { beforeEach, describe, it, expect } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WikiPublishError, WikiService } from '../../../src/application/wiki-service.js';
import { resetWslGitnexusCache } from '../../../src/infrastructure/code-intelligence/cli-runner.js';

beforeEach(() => {
  process.env['GITNEXUS_USE_WSL'] = '0';
  process.env['GITNEXUS_BIN'] = 'gitnexus';
  resetWslGitnexusCache();
});

describe('WikiService', () => {
  it('skips the GitHub wiki probe when probeRemote is false', async () => {
    const calls: string[][] = [];
    const service = new WikiService('/repo', async (_command, args) => {
      calls.push(args);
      if (args.includes('--abbrev-ref')) return { stdout: 'main\n', stderr: '' };
      if (args.includes('symbolic-ref')) return { stdout: 'refs/remotes/origin/main\n', stderr: '' };
      if (args.includes('rev-parse')) return { stdout: 'abc\n', stderr: '' };
      if (args.includes('--get') || args.includes('remote')) return { stdout: 'https://github.com/acme/orch.git\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const status = await service.status({ probeRemote: false });
    expect(status.bootstrap_required).toBe(false);
    expect(calls.some((args) => args.includes('ls-remote'))).toBe(false);
  });

  it('runs `gitnexus wiki` without a fake generate subcommand', async () => {
    const calls: string[][] = [];
    const service = new WikiService('/repo', async (command, args) => {
      calls.push([command, ...args]);
      return { stdout: 'ok', stderr: '' };
    });
    await service.generate();
    const wikiCall = calls.find((row) => row.includes('wiki'));
    expect(wikiCall).toBeDefined();
    expect(wikiCall).not.toContain('generate');
    expect(wikiCall).not.toContain('publish');
  });

  it('refuses publish off the default branch', async () => {
    const service = new WikiService('/repo', async (_command, args) => {
      if (args.includes('--abbrev-ref')) return { stdout: 'feature/ENG-142\n', stderr: '' };
      if (args.includes('symbolic-ref')) return { stdout: 'refs/remotes/origin/main\n', stderr: '' };
      if (args.includes('rev-parse')) return { stdout: 'abc\n', stderr: '' };
      if (args.includes('--get')) return { stdout: 'https://github.com/acme/orch.git\n', stderr: '' };
      if (args.includes('ls-remote')) return { stdout: 'deadbeef\tHEAD\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    await expect(service.publish()).rejects.toBeInstanceOf(WikiPublishError);
  });

  it('reports BOOTSTRAP_REQUIRED instead of publishing an uninitialized GitHub wiki', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-wiki-'));
    try {
      const service = new WikiService(root, async (_command, args) => {
        if (args.includes('--abbrev-ref')) return { stdout: 'main\n', stderr: '' };
        if (args.includes('symbolic-ref')) return { stdout: 'refs/remotes/origin/main\n', stderr: '' };
        if (args.includes('rev-parse')) return { stdout: 'abc123\n', stderr: '' };
        if (args.includes('--get')) return { stdout: 'https://github.com/acme/orch.git\n', stderr: '' };
        if (args.includes('ls-remote')) throw new Error('Repository not found');
        return { stdout: '', stderr: '' };
      });
      const result = await service.publish();
      expect(result.bootstrap_required).toBe(true);
      expect(result.stdout).toContain('BOOTSTRAP_REQUIRED');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('publishes generated pages through the GitLab wiki API', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-wiki-gl-'));
    const previous = process.env['ORCH_GITLAB_WIKI_TOKEN'];
    process.env['ORCH_GITLAB_WIKI_TOKEN'] = 'glpat-test';
    const calls: Array<{ url: string; method: string }> = [];
    try {
      await mkdir(path.join(root, '.gitnexus', 'wiki'), { recursive: true });
      await writeFile(path.join(root, '.gitnexus', 'wiki', 'overview.md'), '# Overview\n', 'utf8');
      const http = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        calls.push({ url, method });
        if (method === 'GET') {
          return new Response(JSON.stringify([{ slug: 'notes', title: 'notes', content: 'human' }]), { status: 200 });
        }
        return new Response('{}', { status: 201 });
      }) as typeof fetch;
      const service = new WikiService(root, async (_command, args) => {
        if (args.includes('--abbrev-ref')) return { stdout: 'main\n', stderr: '' };
        if (args.includes('symbolic-ref')) return { stdout: 'refs/remotes/origin/main\n', stderr: '' };
        if (args.includes('rev-parse')) return { stdout: 'abc123\n', stderr: '' };
        if (args.includes('--get')) return { stdout: 'https://gitlab.com/acme/orch.git\n', stderr: '' };
        return { stdout: '', stderr: '' };
      }, http);
      const result = await service.publish();
      expect(result.pages_published).toBe(1);
      expect(calls.some((call) => call.method === 'POST' && call.url.includes('/wikis'))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env['ORCH_GITLAB_WIKI_TOKEN'];
      else process.env['ORCH_GITLAB_WIKI_TOKEN'] = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses `gh auth token` for GitHub wiki when GITHUB_TOKEN is unset', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-wiki-gh-'));
    const previousGithub = process.env['GITHUB_TOKEN'];
    const previousOrch = process.env['ORCH_GITHUB_WIKI_TOKEN'];
    delete process.env['GITHUB_TOKEN'];
    delete process.env['ORCH_GITHUB_WIKI_TOKEN'];
    const calls: string[][] = [];
    try {
      await mkdir(path.join(root, '.gitnexus', 'wiki'), { recursive: true });
      await writeFile(path.join(root, '.gitnexus', 'wiki', 'overview.md'), '# Overview\n', 'utf8');
      const service = new WikiService(root, async (command, args) => {
        calls.push([command, ...args]);
        if (command === 'gh' && args.includes('token')) return { stdout: 'gho_from_cli\n', stderr: '' };
        if (args.includes('--abbrev-ref')) return { stdout: 'main\n', stderr: '' };
        if (args.includes('symbolic-ref')) return { stdout: 'refs/remotes/origin/main\n', stderr: '' };
        if (args.includes('rev-parse')) return { stdout: 'abc123\n', stderr: '' };
        if (args.includes('--get') || args.includes('remote')) return { stdout: 'https://github.com/acme/orch.git\n', stderr: '' };
        if (args.includes('ls-remote')) return { stdout: 'deadbeef\tHEAD\n', stderr: '' };
        if (args.includes('clone')) {
          const dest = args[args.length - 1];
          if (dest) await mkdir(dest, { recursive: true });
          return { stdout: '', stderr: '' };
        }
        if (args.includes('status')) return { stdout: '', stderr: '' };
        return { stdout: '', stderr: '' };
      });
      const result = await service.publish();
      expect(calls.some((row) => row[0] === 'gh' && row.includes('token'))).toBe(true);
      expect(calls.some((row) => row.includes('clone') && row.some((arg) => arg.includes('x-access-token:gho_from_cli@')))).toBe(true);
      expect(result.pages_published).toBe(1);
    } finally {
      if (previousGithub === undefined) delete process.env['GITHUB_TOKEN'];
      else process.env['GITHUB_TOKEN'] = previousGithub;
      if (previousOrch === undefined) delete process.env['ORCH_GITHUB_WIKI_TOKEN'];
      else process.env['ORCH_GITHUB_WIKI_TOKEN'] = previousOrch;
      await rm(root, { recursive: true, force: true });
    }
  });
});
