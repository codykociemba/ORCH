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
    expect(status.bootstrap_url).toBeUndefined();
    expect(calls.some((args) => args.includes('ls-remote'))).toBe(false);
  });

  it('prefers the branch push remote over origin when detecting the wiki host', async () => {
    const service = new WikiService('/repo', async (_command, args) => {
      if (args.includes('@{push}')) return { stdout: 'refs/remotes/upstream/main\n', stderr: '' };
      if (args.includes('remote.upstream.url')) return { stdout: 'https://gitlab.com/acme/orch.git\n', stderr: '' };
      if (args.includes('remote.origin.url')) return { stdout: 'https://github.com/acme/orch.git\n', stderr: '' };
      if (args.includes('--abbrev-ref') && !args.includes('@{push}')) return { stdout: 'main\n', stderr: '' };
      if (args.includes('symbolic-ref')) return { stdout: 'refs/remotes/origin/main\n', stderr: '' };
      if (args.includes('rev-parse')) return { stdout: 'abc\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    const status = await service.status({ probeRemote: false });
    expect(status.host).toBe('gitlab');
    expect(status.origin).toContain('gitlab.com/acme/orch');
  });

  it('points at the GitHub wiki _new form when bootstrap is required', async () => {
    const service = new WikiService('/repo', async (_command, args) => {
      if (args.includes('--abbrev-ref')) return { stdout: 'main\n', stderr: '' };
      if (args.includes('symbolic-ref')) return { stdout: 'refs/remotes/origin/main\n', stderr: '' };
      if (args.includes('rev-parse')) return { stdout: 'abc\n', stderr: '' };
      if (args.includes('--get') || args.includes('remote')) return { stdout: 'https://github.com/acme/orch.git\n', stderr: '' };
      if (args.includes('ls-remote')) throw new Error('Repository not found');
      return { stdout: '', stderr: '' };
    });
    const status = await service.status();
    expect(status.bootstrap_required).toBe(true);
    expect(status.bootstrap_url).toBe('https://github.com/acme/orch/wiki/_new');
  });

  it('does not claim a current GitNexus index when the probe says otherwise', async () => {
    const service = new WikiService(
      '/repo',
      async (_command, args) => {
        if (args.includes('--abbrev-ref')) return { stdout: 'main\n', stderr: '' };
        if (args.includes('symbolic-ref')) return { stdout: 'refs/remotes/origin/main\n', stderr: '' };
        if (args.includes('rev-parse')) return { stdout: 'abc\n', stderr: '' };
        if (args.includes('--get') || args.includes('remote')) return { stdout: 'https://github.com/acme/orch.git\n', stderr: '' };
        return { stdout: '', stderr: '' };
      },
      fetch,
      async () => false,
    );
    const status = await service.status({ probeRemote: false });
    expect(status.index_current).toBe(false);
    const evidence = await service.evidence('local-preview');
    expect(evidence.index_current).toBe(false);
    expect(evidence.status).toBe('failed');
    expect(evidence.pages_published).toBeUndefined();
    expect(evidence.summary).toMatch(/not current/);
    expect(evidence.failed_modules).toEqual([]);
  });

  it('attaches the canonical wiki home URL when the remote wiki exists', async () => {
    const service = new WikiService(
      '/repo',
      async (command, args) => {
        if (command === 'gh' && args.includes('token')) return { stdout: 'gho_test\n', stderr: '' };
        if (args.includes('--abbrev-ref')) return { stdout: 'main\n', stderr: '' };
        if (args.includes('symbolic-ref')) return { stdout: 'refs/remotes/origin/main\n', stderr: '' };
        if (args.includes('rev-parse')) return { stdout: 'abc\n', stderr: '' };
        if (args.includes('--get') || args.includes('remote')) return { stdout: 'https://github.com/acme/orch.git\n', stderr: '' };
        if (args.includes('ls-remote')) return { stdout: 'deadbeef\tHEAD\n', stderr: '' };
        return { stdout: '', stderr: '' };
      },
      fetch,
      async () => true,
    );
    const evidence = await service.evidence('canonical-publish');
    expect(evidence.canonical_wiki_url).toBe('https://github.com/acme/orch/wiki');
    expect(evidence.pages_published).toBeDefined();
  });

  it('runs `gitnexus wiki` without a fake generate subcommand', async () => {
    const calls: string[][] = [];
    const service = new WikiService(
      '/repo',
      async (command, args) => {
        calls.push([command, ...args]);
        return { stdout: 'ok', stderr: '' };
      },
      fetch,
      async () => true,
    );
    await service.generate(['--provider', 'claude']);
    const wikiCall = calls.find((row) => row.includes('wiki'));
    expect(wikiCall).toBeDefined();
    expect(wikiCall).not.toContain('generate');
    expect(wikiCall).not.toContain('publish');
    expect(wikiCall?.filter((arg) => arg === '--provider')).toHaveLength(1);
    expect(wikiCall).toContain('claude');
  });

  it('warns when generate runs against a stale GitNexus index', async () => {
    const calls: string[][] = [];
    const service = new WikiService(
      '/repo',
      async (_command, args) => {
        calls.push(args);
        return { stdout: 'ok', stderr: '' };
      },
      fetch,
      async () => false,
    );
    const result = await service.generate();
    expect(calls.some((row) => row.includes('analyze') && row.includes('--index-only'))).toBe(true);
    expect(result.stdout).toMatch(/index is not current/);
    expect(result.stdout).toContain('ok');
  });

  it('does not pass automatic --force when the GitNexus index is stale', async () => {
    const previous = process.env['GITNEXUS_WIKI_FORCE'];
    process.env['GITNEXUS_WIKI_FORCE'] = '1';
    const calls: string[][] = [];
    try {
      const service = new WikiService(
        '/repo',
        async (_command, args) => {
          calls.push(args);
          return { stdout: 'ok', stderr: '' };
        },
        fetch,
        async () => false,
      );
      const result = await service.generate();
      const wikiCall = calls.find((row) => row.includes('wiki'));
      expect(wikiCall).toBeDefined();
      expect(wikiCall).not.toContain('--force');
      expect(result.stdout).toMatch(/Refused automatic --force/);
    } finally {
      if (previous === undefined) delete process.env['GITNEXUS_WIKI_FORCE'];
      else process.env['GITNEXUS_WIKI_FORCE'] = previous;
    }
  });

  it('refuses canonical publish when the GitNexus index is stale', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-wiki-stale-pub-'));
    try {
      await mkdir(path.join(root, '.gitnexus', 'wiki'), { recursive: true });
      await writeFile(path.join(root, '.gitnexus', 'wiki', 'overview.md'), '# Overview\n', 'utf8');
      const service = new WikiService(
        root,
        async (command, args) => {
          if (command === 'gh' && args.includes('token')) return { stdout: 'gho_test\n', stderr: '' };
          if (args.includes('--abbrev-ref')) return { stdout: 'main\n', stderr: '' };
          if (args.includes('symbolic-ref')) return { stdout: 'refs/remotes/origin/main\n', stderr: '' };
          if (args.includes('rev-parse')) return { stdout: 'abc123\n', stderr: '' };
          if (args.includes('--get') || args.includes('remote')) {
            return { stdout: 'https://github.com/acme/orch.git\n', stderr: '' };
          }
          if (args.includes('ls-remote')) return { stdout: 'deadbeef\tHEAD\n', stderr: '' };
          return { stdout: '', stderr: '' };
        },
        fetch,
        async () => false,
      );
      await expect(service.publish()).rejects.toThrow(/index is not current/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  it('lets a trusted default-branch CI caller continue when git reports detached HEAD', async () => {
    const service = new WikiService('/repo', async (_command, args) => {
      if (args.includes('--abbrev-ref')) return { stdout: 'HEAD\n', stderr: '' };
      if (args.includes('symbolic-ref')) return { stdout: 'refs/remotes/origin/main\n', stderr: '' };
      if (args.includes('rev-parse')) return { stdout: 'abc\n', stderr: '' };
      if (args.includes('--get')) return { stdout: 'https://github.com/acme/orch.git\n', stderr: '' };
      if (args.includes('ls-remote')) throw new Error('Repository not found');
      if (args.includes('push')) throw new Error('Wiki git repo does not exist');
      return { stdout: '', stderr: '' };
    });
    await expect(service.publish()).rejects.toBeInstanceOf(WikiPublishError);
    const result = await service.publish({ trustedDefaultBranch: true });
    expect(result.bootstrap_required).toBe(true);
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
        if (args.includes('push')) throw new Error('Wiki git repo does not exist');
        return { stdout: '', stderr: '' };
      });
      const result = await service.publish();
      expect(result.bootstrap_required).toBe(true);
      expect(result.stdout).toContain('BOOTSTRAP_REQUIRED');
      expect(result.stdout).toContain('enable the Wiki if needed');
      expect(result.stdout).not.toContain('A first git push cannot create');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('bootstraps an empty GitHub wiki with a first Home.md push, then publishes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-wiki-boot-'));
    const calls: string[][] = [];
    try {
      await mkdir(path.join(root, '.gitnexus', 'wiki'), { recursive: true });
      await writeFile(path.join(root, '.gitnexus', 'wiki', 'overview.md'), '# Overview\n', 'utf8');
      const service = new WikiService(root, async (command, args) => {
        calls.push([command, ...args]);
        if (command === 'gh' && args.includes('token')) return { stdout: 'gho_boot\n', stderr: '' };
        if (args.includes('--abbrev-ref')) return { stdout: 'main\n', stderr: '' };
        if (args.includes('symbolic-ref')) return { stdout: 'refs/remotes/origin/main\n', stderr: '' };
        if (args.includes('rev-parse')) return { stdout: 'abc123\n', stderr: '' };
        if (args.includes('--get') || args.includes('remote')) return { stdout: 'https://github.com/acme/orch.git\n', stderr: '' };
        if (args.includes('ls-remote')) throw new Error('Repository not found');
        if (args.includes('clone')) {
          const dest = args[args.length - 1];
          if (dest) await mkdir(dest, { recursive: true });
          return { stdout: '', stderr: '' };
        }
        if (args.includes('status')) return { stdout: '', stderr: '' };
        return { stdout: '', stderr: '' };
      }, fetch, async () => true);
      const result = await service.publish();
      expect(result.bootstrap_required).toBeUndefined();
      expect(result.pages_published).toBe(1);
      expect(calls.some((row) => row.includes('has_wiki=true'))).toBe(true);
      expect(calls.some((row) => row.includes('push') && row.includes('HEAD:master'))).toBe(true);
      expect(calls.some((row) => row.includes('clone'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retries a transient GitHub wiki bootstrap push then publishes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-wiki-boot-retry-'));
    const calls: string[][] = [];
    let masterPushes = 0;
    try {
      await mkdir(path.join(root, '.gitnexus', 'wiki'), { recursive: true });
      await writeFile(path.join(root, '.gitnexus', 'wiki', 'overview.md'), '# Overview\n', 'utf8');
      const service = new WikiService(root, async (command, args) => {
        calls.push([command, ...args]);
        if (command === 'gh' && args.includes('token')) return { stdout: 'gho_boot\n', stderr: '' };
        if (args.includes('--abbrev-ref')) return { stdout: 'main\n', stderr: '' };
        if (args.includes('symbolic-ref')) return { stdout: 'refs/remotes/origin/main\n', stderr: '' };
        if (args.includes('rev-parse')) return { stdout: 'abc123\n', stderr: '' };
        if (args.includes('--get') || args.includes('remote')) return { stdout: 'https://github.com/acme/orch.git\n', stderr: '' };
        if (args.includes('ls-remote')) throw new Error('Repository not found');
        if (args.includes('push') && args.includes('HEAD:master')) {
          masterPushes += 1;
          if (masterPushes === 1) throw new Error('bootstrap push 502');
          return { stdout: '', stderr: '' };
        }
        if (args.includes('clone')) {
          const dest = args[args.length - 1];
          if (dest) await mkdir(dest, { recursive: true });
          return { stdout: '', stderr: '' };
        }
        if (args.includes('status')) return { stdout: '', stderr: '' };
        return { stdout: '', stderr: '' };
      }, fetch, async () => true);
      const result = await service.publish();
      expect(result.bootstrap_required).toBeUndefined();
      expect(result.pages_published).toBe(1);
      expect(masterPushes).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retries a transient GitHub wiki clone then publishes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-wiki-gh-retry-'));
    const calls: string[][] = [];
    let clones = 0;
    try {
      await mkdir(path.join(root, '.gitnexus', 'wiki'), { recursive: true });
      await writeFile(path.join(root, '.gitnexus', 'wiki', 'overview.md'), '# Overview\n', 'utf8');
      const service = new WikiService(root, async (command, args) => {
        calls.push([command, ...args]);
        if (command === 'gh' && args.includes('token')) return { stdout: 'gho_retry\n', stderr: '' };
        if (args.includes('--abbrev-ref')) return { stdout: 'main\n', stderr: '' };
        if (args.includes('symbolic-ref')) return { stdout: 'refs/remotes/origin/main\n', stderr: '' };
        if (args.includes('rev-parse')) return { stdout: 'abc123\n', stderr: '' };
        if (args.includes('--get') || args.includes('remote')) return { stdout: 'https://github.com/acme/orch.git\n', stderr: '' };
        if (args.includes('ls-remote')) return { stdout: 'deadbeef\tHEAD\n', stderr: '' };
        if (args.includes('clone')) {
          clones += 1;
          if (clones === 1) throw new Error('clone 502');
          const dest = args[args.length - 1];
          if (dest) await mkdir(dest, { recursive: true });
          return { stdout: '', stderr: '' };
        }
        if (args.includes('status')) return { stdout: 'M Home.md\n', stderr: '' };
        return { stdout: '', stderr: '' };
      }, fetch, async () => true);
      const result = await service.publish();
      expect(result.pages_published).toBe(1);
      expect(clones).toBe(2);
      expect(calls.filter((row) => row.includes('clone')).length).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retries GitLab wiki HTTP 503 then publishes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-wiki-gl-retry-'));
    const previous = process.env['ORCH_GITLAB_WIKI_TOKEN'];
    process.env['ORCH_GITLAB_WIKI_TOKEN'] = 'glpat-test';
    let attempts = 0;
    try {
      await mkdir(path.join(root, '.gitnexus', 'wiki'), { recursive: true });
      await writeFile(path.join(root, '.gitnexus', 'wiki', 'overview.md'), '# Overview\n', 'utf8');
      const http = (async (input: RequestInfo | URL, init?: RequestInit) => {
        attempts += 1;
        if (attempts < 3) return new Response('unavailable', { status: 503 });
        const method = init?.method ?? 'GET';
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
      }, http, async () => true);
      const result = await service.publish();
      expect(result.pages_published).toBe(1);
      expect(attempts).toBeGreaterThanOrEqual(3);
    } finally {
      if (previous === undefined) delete process.env['ORCH_GITLAB_WIKI_TOKEN'];
      else process.env['ORCH_GITLAB_WIKI_TOKEN'] = previous;
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
      }, http, async () => true);
      const result = await service.publish();
      expect(result.pages_published).toBe(1);
      expect(calls.some((call) => call.method === 'POST' && call.url.includes('/wikis'))).toBe(true);
      expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
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
      }, fetch, async () => true);
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

  it('updates marked GitLab pages, deletes stale generated pages, and preserves human pages', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-wiki-gl-sync-'));
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
          return new Response(JSON.stringify([
            { slug: 'home', title: 'home', content: '<!-- orch-wiki:generated sha=old -->\nold' },
            { slug: 'stale', title: 'stale', content: '<!-- orch-wiki:generated sha=old -->\nstale' },
            { slug: 'notes', title: 'notes', content: 'human notes' },
          ]), { status: 200 });
        }
        return new Response('{}', { status: 200 });
      }) as typeof fetch;
      const service = new WikiService(root, async (_command, args) => {
        if (args.includes('--abbrev-ref')) return { stdout: 'main\n', stderr: '' };
        if (args.includes('symbolic-ref')) return { stdout: 'refs/remotes/origin/main\n', stderr: '' };
        if (args.includes('rev-parse')) return { stdout: 'def5678\n', stderr: '' };
        if (args.includes('--get')) return { stdout: 'https://gitlab.com/acme/orch.git\n', stderr: '' };
        return { stdout: '', stderr: '' };
      }, http, async () => true);
      const result = await service.publish();
      expect(result.pages_published).toBe(1);
      expect(calls.some((call) => call.method === 'PUT' && call.url.includes('/wikis/home'))).toBe(true);
      expect(calls.some((call) => call.method === 'DELETE' && call.url.includes('/wikis/stale'))).toBe(true);
      expect(calls.some((call) => call.method === 'DELETE' && call.url.includes('/wikis/notes'))).toBe(false);
    } finally {
      if (previous === undefined) delete process.env['ORCH_GITLAB_WIKI_TOKEN'];
      else process.env['ORCH_GITLAB_WIKI_TOKEN'] = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the GitLab wiki feature is disabled', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-wiki-gl-off-'));
    const previous = process.env['ORCH_GITLAB_WIKI_TOKEN'];
    process.env['ORCH_GITLAB_WIKI_TOKEN'] = 'glpat-test';
    try {
      await mkdir(path.join(root, '.gitnexus', 'wiki'), { recursive: true });
      await writeFile(path.join(root, '.gitnexus', 'wiki', 'overview.md'), '# Overview\n', 'utf8');
      const http = (async () => new Response('Wiki disabled', { status: 403 })) as typeof fetch;
      const service = new WikiService(root, async (_command, args) => {
        if (args.includes('--abbrev-ref')) return { stdout: 'main\n', stderr: '' };
        if (args.includes('symbolic-ref')) return { stdout: 'refs/remotes/origin/main\n', stderr: '' };
        if (args.includes('rev-parse')) return { stdout: 'abc123\n', stderr: '' };
        if (args.includes('--get')) return { stdout: 'https://gitlab.com/acme/orch.git\n', stderr: '' };
        return { stdout: '', stderr: '' };
      }, http, async () => true);
      await expect(service.publish()).rejects.toThrow(WikiPublishError);
      await expect(service.publish()).rejects.toThrow(/Wiki feature is enabled|GitLab wiki list failed/);
    } finally {
      if (previous === undefined) delete process.env['ORCH_GITLAB_WIKI_TOKEN'];
      else process.env['ORCH_GITLAB_WIKI_TOKEN'] = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not let public github.com host lists override mixed remotes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-wiki-mixed-'));
    try {
      await mkdir(path.join(root, '.orch'), { recursive: true });
      await writeFile(
        path.join(root, '.orch', 'workflow.yml'),
        'wiki:\n  provider: auto\n  github_hosts:\n    - github.com\n  gitlab_hosts:\n    - gitlab.com\n',
        'utf8',
      );
      const service = new WikiService(root, async (_command, args) => {
        if (args.includes('--abbrev-ref')) return { stdout: 'main\n', stderr: '' };
        if (args.includes('symbolic-ref')) return { stdout: 'refs/remotes/origin/main\n', stderr: '' };
        if (args.includes('rev-parse')) return { stdout: 'abc\n', stderr: '' };
        if (args.includes('@{push}')) throw new Error('no push');
        if (args.includes('remote.pushDefault')) throw new Error('none');
        if (args.includes('remote.origin.url') || args.includes('--get')) {
          return { stdout: 'https://github.com/acme/orch.git\n', stderr: '' };
        }
        if (args[0] === 'remote' && args[1] === '-v') {
          return {
            stdout: 'origin\thttps://github.com/acme/orch.git (fetch)\nupstream\thttps://gitlab.com/acme/orch.git (fetch)\n',
            stderr: '',
          };
        }
        return { stdout: '', stderr: '' };
      });
      const status = await service.status({ probeRemote: false });
      expect(status.host).toBe('unknown');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('maps a configured GitLab self-hosted host onto the GitLab publisher', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-wiki-gl-host-'));
    try {
      await mkdir(path.join(root, '.orch'), { recursive: true });
      await writeFile(
        path.join(root, '.orch', 'workflow.yml'),
        'wiki:\n  provider: auto\n  gitlab_hosts:\n    - git.internal.net\n',
        'utf8',
      );
      const service = new WikiService(root, async (_command, args) => {
        if (args.includes('--abbrev-ref')) return { stdout: 'main\n', stderr: '' };
        if (args.includes('symbolic-ref')) return { stdout: 'refs/remotes/origin/main\n', stderr: '' };
        if (args.includes('rev-parse')) return { stdout: 'abc\n', stderr: '' };
        if (args.includes('--get') || args.includes('remote')) {
          return { stdout: 'https://git.internal.net/acme/orch.git\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });
      const status = await service.status({ probeRemote: false });
      expect(status.host).toBe('gitlab');
      expect(status.owner).toBe('acme');
      expect(status.repo).toBe('orch');
      const evidence = await service.evidence('canonical-publish');
      expect(evidence.canonical_wiki_url).toBe('https://git.internal.net/acme/orch/-/wikis/home');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('maps a configured GitHub Enterprise host onto the GitHub publisher', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-wiki-ghe-'));
    try {
      await mkdir(path.join(root, '.orch'), { recursive: true });
      await writeFile(
        path.join(root, '.orch', 'workflow.yml'),
        'wiki:\n  provider: auto\n  github_hosts:\n    - git.company.com\n',
        'utf8',
      );
      const service = new WikiService(root, async (command, args) => {
        if (command === 'gh' && args.includes('token')) return { stdout: 'gho_test\n', stderr: '' };
        if (args.includes('--abbrev-ref')) return { stdout: 'main\n', stderr: '' };
        if (args.includes('symbolic-ref')) return { stdout: 'refs/remotes/origin/main\n', stderr: '' };
        if (args.includes('rev-parse')) return { stdout: 'abc\n', stderr: '' };
        if (args.includes('ls-remote')) return { stdout: 'deadbeef\tHEAD\n', stderr: '' };
        if (args.includes('--get') || args.includes('remote')) {
          return { stdout: 'https://git.company.com/acme/orch.git\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      });
      const status = await service.status({ probeRemote: false });
      expect(status.host).toBe('github');
      expect(status.owner).toBe('acme');
      expect(status.repo).toBe('orch');
      const evidence = await service.evidence('canonical-publish');
      expect(evidence.canonical_wiki_url).toBe('https://git.company.com/acme/orch/wiki');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses the self-hosted GitLab wiki API base from CI vars', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-wiki-gl-self-'));
    const previousToken = process.env['ORCH_GITLAB_WIKI_TOKEN'];
    const previousApi = process.env['CI_API_V4_URL'];
    const previousProject = process.env['CI_PROJECT_URL'];
    process.env['ORCH_GITLAB_WIKI_TOKEN'] = 'glpat-test';
    process.env['CI_API_V4_URL'] = 'https://git.example.com/api/v4';
    process.env['CI_PROJECT_URL'] = 'https://git.example.com/acme/orch';
    const urls: string[] = [];
    try {
      await mkdir(path.join(root, '.gitnexus', 'wiki'), { recursive: true });
      await writeFile(path.join(root, '.gitnexus', 'wiki', 'overview.md'), '# Overview\n', 'utf8');
      const http = (async (input: RequestInfo | URL, init?: RequestInit) => {
        urls.push(String(input));
        if ((init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify([]), { status: 200 });
        return new Response('{}', { status: 201 });
      }) as typeof fetch;
      const service = new WikiService(root, async (_command, args) => {
        if (args.includes('--abbrev-ref')) return { stdout: 'main\n', stderr: '' };
        if (args.includes('symbolic-ref')) return { stdout: 'refs/remotes/origin/main\n', stderr: '' };
        if (args.includes('rev-parse')) return { stdout: 'abc123\n', stderr: '' };
        if (args.includes('--get')) return { stdout: 'https://git.example.com/acme/orch.git\n', stderr: '' };
        return { stdout: '', stderr: '' };
      }, http, async () => true);
      await service.publish();
      expect(urls.some((url) => url.startsWith('https://git.example.com/api/v4/projects/'))).toBe(true);
    } finally {
      if (previousToken === undefined) delete process.env['ORCH_GITLAB_WIKI_TOKEN'];
      else process.env['ORCH_GITLAB_WIKI_TOKEN'] = previousToken;
      if (previousApi === undefined) delete process.env['CI_API_V4_URL'];
      else process.env['CI_API_V4_URL'] = previousApi;
      if (previousProject === undefined) delete process.env['CI_PROJECT_URL'];
      else process.env['CI_PROJECT_URL'] = previousProject;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('derives the GitLab wiki API base from a self-hosted origin when CI vars are absent', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-wiki-gl-origin-'));
    const previousToken = process.env['ORCH_GITLAB_WIKI_TOKEN'];
    const previousApi = process.env['CI_API_V4_URL'];
    const previousGitlabApi = process.env['GITLAB_API_URL'];
    process.env['ORCH_GITLAB_WIKI_TOKEN'] = 'glpat-test';
    delete process.env['CI_API_V4_URL'];
    delete process.env['GITLAB_API_URL'];
    const urls: string[] = [];
    try {
      await mkdir(path.join(root, '.orch'), { recursive: true });
      await writeFile(
        path.join(root, '.orch', 'workflow.yml'),
        'wiki:\n  provider: auto\n  gitlab_hosts:\n    - git.internal.net\n',
        'utf8',
      );
      await mkdir(path.join(root, '.gitnexus', 'wiki'), { recursive: true });
      await writeFile(path.join(root, '.gitnexus', 'wiki', 'overview.md'), '# Overview\n', 'utf8');
      const http = (async (input: RequestInfo | URL, init?: RequestInit) => {
        urls.push(String(input));
        if ((init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify([]), { status: 200 });
        return new Response('{}', { status: 201 });
      }) as typeof fetch;
      const service = new WikiService(root, async (_command, args) => {
        if (args.includes('--abbrev-ref')) return { stdout: 'main\n', stderr: '' };
        if (args.includes('symbolic-ref')) return { stdout: 'refs/remotes/origin/main\n', stderr: '' };
        if (args.includes('rev-parse')) return { stdout: 'abc123\n', stderr: '' };
        if (args.includes('--get') || args.includes('remote')) {
          return { stdout: 'https://git.internal.net/acme/orch.git\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      }, http, async () => true);
      await service.publish();
      expect(urls.some((url) => url.startsWith('https://git.internal.net/api/v4/projects/'))).toBe(true);
    } finally {
      if (previousToken === undefined) delete process.env['ORCH_GITLAB_WIKI_TOKEN'];
      else process.env['ORCH_GITLAB_WIKI_TOKEN'] = previousToken;
      if (previousApi === undefined) delete process.env['CI_API_V4_URL'];
      else process.env['CI_API_V4_URL'] = previousApi;
      if (previousGitlabApi === undefined) delete process.env['GITLAB_API_URL'];
      else process.env['GITLAB_API_URL'] = previousGitlabApi;
      await rm(root, { recursive: true, force: true });
    }
  });
});
