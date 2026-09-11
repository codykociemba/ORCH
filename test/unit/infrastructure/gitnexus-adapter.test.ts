import { describe, it, expect, vi } from 'vitest';
import { GitNexusCodeIntelligence, createLazyCodeIntelligence } from '../../../src/infrastructure/code-intelligence/gitnexus-adapter.js';
import { CodeIntelligenceError } from '../../../src/domain/errors.js';
import type { ICliRunner, IMcpToolCaller } from '../../../src/infrastructure/code-intelligence/interface.js';
import { gitnexusBinForWiki, resolveGitnexusSpawn, toWslPath, wrapWslGitnexus } from '../../../src/infrastructure/code-intelligence/cli-runner.js';
import { parseGitNexusToolText } from '../../../src/infrastructure/code-intelligence/mcp-stdio-client.js';

function cli(stdout: string, code = 0): ICliRunner {
  return {
    run: vi.fn(async () => ({ code, stdout, stderr: '' })),
  };
}

function mcp(handler: (name: string, args: Record<string, unknown>) => unknown): IMcpToolCaller {
  return {
    callTool: vi.fn(async (name, args) => handler(name, args)),
    close: vi.fn(async () => {}),
  };
}

describe('GitNexusCodeIntelligence', () => {
  it('maps mixed banner + not-indexed JSON as stale', async () => {
    const adapter = new GitNexusCodeIntelligence({
      projectRoot: '/repo',
      cli: cli('  GitNexus Status (1.6.11)\n{"schemaVersion":1,"repository":"C:\\\\repo","error":"not-indexed"}\n'),
    });
    const status = await adapter.getRepositoryStatus({ repository_root: '/repo' });
    expect(status.available).toBe(false);
    expect(status.current).toBe(false);
    expect(status.incomplete_reasons).toContain('not-indexed');
    expect(status.repo).toContain('repo');
  });

  it('maps status --json freshness', async () => {
    const adapter = new GitNexusCodeIntelligence({
      projectRoot: '/repo',
      cli: cli(JSON.stringify({ repo: 'orch', current: true, index_commit: 'deadbeef' })),
    });
    const status = await adapter.getRepositoryStatus({ repository_root: '/repo' });
    expect(status.available).toBe(true);
    expect(status.current).toBe(true);
    expect(status.index_commit).toBe('deadbeef');
  });

  it('maps GitNexus 1.6 status object + content drift as stale', async () => {
    const adapter = new GitNexusCodeIntelligence({
      projectRoot: '/repo',
      cli: cli(JSON.stringify({
        schemaVersion: 1,
        repository: 'C:\\\\repo',
        index: { commit: 'c066dc0', incompleteReasons: [] },
        current: { commit: 'c066dc0' },
        contentDrift: { status: 'drifted', counts: { changed: 2 } },
        status: 'stale',
      })),
    });
    const status = await adapter.getRepositoryStatus({ repository_root: '/repo' });
    expect(status.available).toBe(true);
    expect(status.current).toBe(false);
    expect(status.index_commit).toBe('c066dc0');
    expect(status.incomplete_reasons).toEqual(expect.arrayContaining(['stale', 'content-drift']));
  });

  it('maps GitNexus 1.6 status=current as fresh', async () => {
    const adapter = new GitNexusCodeIntelligence({
      projectRoot: '/repo',
      cli: cli(JSON.stringify({
        schemaVersion: 1,
        repository: 'ORCH',
        index: { commit: 'abc123', incompleteReasons: [] },
        current: { commit: 'abc123' },
        contentDrift: { status: 'clean' },
        status: 'current',
      })),
    });
    const status = await adapter.getRepositoryStatus({ repository_root: '/repo' });
    expect(status.available).toBe(true);
    expect(status.current).toBe(true);
    expect(status.index_commit).toBe('abc123');
  });

  it('maps query hits', async () => {
    const adapter = new GitNexusCodeIntelligence({
      projectRoot: '/repo',
      cli: cli('{}'),
      mcp: mcp(() => [{ path: 'src/a.ts', symbol: 'retry', score: 0.9 }]),
    });
    const hits = await adapter.searchExisting({ query: 'retry', worktree: '/repo' });
    expect(hits[0]?.symbol).toBe('retry');
    expect(hits[0]?.path).toBe('src/a.ts');
  });

  it('maps GitNexus 1.6 process_symbols from query', async () => {
    const adapter = new GitNexusCodeIntelligence({
      projectRoot: '/repo',
      cli: cli('{}'),
      mcp: mcp(() => ({
        processes: [],
        process_symbols: [{ name: 'calculateRetryDelay', filePath: 'src/application/orchestrator.ts' }],
        definitions: [],
      })),
    });
    const hits = await adapter.searchExisting({ query: 'retry', worktree: '/repo' });
    expect(hits[0]?.symbol).toBe('calculateRetryDelay');
    expect(hits[0]?.path).toBe('src/application/orchestrator.ts');
  });

  it('maps impact unknown risk as unresolved', async () => {
    const adapter = new GitNexusCodeIntelligence({
      projectRoot: '/repo',
      cli: cli('{}'),
      mcp: mcp(() => ({ risk: 'UNKNOWN', direct: 2, total: 9 })),
    });
    const report = await adapter.getImpact({ target: 'Foo', worktree: '/repo' });
    expect(report.risk).toBe('unknown');
    expect(report.unresolved).toBe(true);
    expect(report.direct_dependents).toBe(2);
  });

  it('maps GitNexus 1.6 changed_symbols + risk_level', async () => {
    const adapter = new GitNexusCodeIntelligence({
      projectRoot: '/repo',
      cli: cli('{}'),
      mcp: mcp(() => ({
        changed_symbols: [
          { name: 'newHelper', filePath: 'src/x.ts', change_type: 'added' },
          { name: 'retry', filePath: 'src/r.ts', change_type: 'touched' },
        ],
        risk_level: 'high',
        affected_processes: [{ name: 'HandleRunFailure' }],
        partial: false,
      })),
    });
    const changes = await adapter.detectChanges({ worktree: '/wt' });
    expect(changes.added_symbols[0]?.name).toBe('newHelper');
    expect(changes.modified_symbols[0]?.name).toBe('retry');
    expect(changes.risk).toBe('high');
    expect(changes.processes).toContain('HandleRunFailure');
  });

  it('maps detect_changes and preserves partial/truncated', async () => {
    const adapter = new GitNexusCodeIntelligence({
      projectRoot: '/repo',
      cli: cli('{}'),
      mcp: mcp(() => ({
        added: [{ name: 'newHelper', path: 'src/x.ts' }],
        partial: true,
        truncated: true,
      })),
    });
    const changes = await adapter.detectChanges({ worktree: '/wt' });
    expect(changes.added_symbols[0]?.name).toBe('newHelper');
    expect(changes.partial).toBe(true);
    expect(changes.truncated).toBe(true);
  });

  it('refuses detect_changes without a worktree', async () => {
    const adapter = new GitNexusCodeIntelligence({
      projectRoot: '/repo',
      cli: cli('{}'),
      mcp: mcp(() => ({})),
    });
    await expect(adapter.detectChanges({ worktree: '' })).rejects.toBeInstanceOf(CodeIntelligenceError);
  });

  it('passes explicit repo + worktree to MCP', async () => {
    const caller = mcp((_name, args) => {
      expect(args['repo']).toBe('orch');
      expect(args['worktree']).toBeUndefined();
      return [{ path: 'src/x.ts', symbol: 'x' }];
    });
    const adapter = new GitNexusCodeIntelligence({
      projectRoot: '/repo',
      repoName: 'orch',
      cli: cli('{}'),
      mcp: caller,
    });
    await adapter.searchExisting({ query: 'x', worktree: '/wt', repo: 'orch' });
    expect(caller.callTool).toHaveBeenCalledWith(
      'query',
      expect.objectContaining({ repo: 'orch', search_query: 'x' }),
    );
    expect(caller.callTool).not.toHaveBeenCalledWith(
      'query',
      expect.objectContaining({ worktree: '/wt' }),
    );
  });

  it('runs analyze with a raised LadybugDB buffer pool when unset', async () => {
    const runner: ICliRunner = {
      run: vi.fn(async (_command, args, _cwd, env) => {
        expect(args).toEqual(['analyze']);
        expect(env?.['GITNEXUS_LBUG_BUFFER_POOL_SIZE']).toBe('2147483648');
        return { code: 0, stdout: 'indexed', stderr: '' };
      }),
    };
    const adapter = new GitNexusCodeIntelligence({
      projectRoot: '/repo',
      cli: runner,
    });
    await adapter.analyze({ repository_root: '/repo' });
    expect(runner.run).toHaveBeenCalled();
  });

  it('points detect_changes at the worker worktree, not repo cwd', async () => {
    const caller = mcp((_name, args) => {
      expect(args['worktree']).toBe('/tmp/orch-wt-fixture');
      return { added: [], partial: false };
    });
    const adapter = new GitNexusCodeIntelligence({
      projectRoot: '/repo',
      repoName: 'orch',
      cli: cli('{}'),
      mcp: caller,
    });
    const changes = await adapter.detectChanges({ worktree: '/tmp/orch-wt-fixture', repo: 'orch' });
    expect(changes.worktree).toBe('/tmp/orch-wt-fixture');
    expect(caller.callTool).toHaveBeenCalledWith(
      'detect_changes',
      expect.objectContaining({ repo: 'orch', worktree: '/tmp/orch-wt-fixture' }),
    );
  });

  it('createLazyCodeIntelligence defers construction until the first call', async () => {
    let built = 0;
    const intelligence = createLazyCodeIntelligence('/repo', () => {
      built += 1;
      return new GitNexusCodeIntelligence({
        projectRoot: '/repo',
        cli: cli(JSON.stringify({ status: 'current', index: { commit: 'abc' } })),
      });
    });
    expect(built).toBe(0);
    const status = await intelligence.getRepositoryStatus({ repository_root: '/repo' });
    expect(built).toBe(1);
    expect(status.current).toBe(true);
    await intelligence.getRepositoryStatus({ repository_root: '/repo' });
    expect(built).toBe(1);
  });
});

describe('parseGitNexusToolText', () => {
  it('strips the Next-step hint after a JSON payload', () => {
    const parsed = parseGitNexusToolText(
      '{"markdown":"| name | path |\\n| --- | --- |\\n| calculateRetryDelay | src/domain/transitions.ts |","row_count":1}\n\n---\n**Next:** use context()',
    );
    expect(parsed).toEqual(expect.objectContaining({ row_count: 1 }));
    const hits = (parsed as { markdown: string }).markdown;
    expect(hits).toContain('calculateRetryDelay');
  });

  it('does not let a Next-hint brace break JSON parsing', () => {
    const parsed = parseGitNexusToolText(
      '{"process_symbols":[],"definitions":[]}\n\n---\n**Next:** use context({name: "retry"})',
    );
    expect(parsed).toEqual({ process_symbols: [], definitions: [] });
  });
});

describe('resolveGitnexusSpawn', () => {
  it('maps a Windows path onto /mnt for WSL GitNexus', () => {
    expect(toWslPath('C:\\Users\\God\\Desktop\\Code\\Konci\\ORCH')).toBe(
      '/mnt/c/Users/God/Desktop/Code/Konci/ORCH',
    );
  });

  it('wraps GitNexus as wsl.exe so native Windows uses the supported runtime', () => {
    const invoked = wrapWslGitnexus(['mcp'], 'C:\\Users\\God\\Desktop\\Code\\Konci\\ORCH');
    expect(invoked.command).toBe('wsl.exe');
    expect(invoked.args[0]).toBe('-e');
    expect(invoked.args.join(' ')).toContain('exec gitnexus');
    expect(invoked.args.join(' ')).toContain('/mnt/c/Users/God/Desktop/Code/Konci/ORCH');
  });

  it('routes the wsl-gitnexus alias through WSL', () => {
    const invoked = resolveGitnexusSpawn('wsl-gitnexus', ['status', '--json'], 'C:\\repo');
    expect(invoked.command).toBe('wsl.exe');
    expect(invoked.args.join(' ')).toContain('status');
  });

  it('does not spawn a Windows .cmd shim when the Node entry exists', () => {
    const invoked = resolveGitnexusSpawn('gitnexus.cmd', ['mcp']);
    if (process.platform === 'win32') {
      expect(invoked.command.toLowerCase()).not.toMatch(/\.cmd$/);
      expect(invoked.args[0]).toMatch(/gitnexus[\\/]dist[\\/]cli[\\/]index\.js$/i);
      expect(invoked.args.slice(1)).toEqual(['mcp']);
    } else {
      expect(invoked).toEqual({ command: 'gitnexus.cmd', args: ['mcp'] });
    }
  });
});

describe('gitnexusBinForWiki', () => {
  it('uses native Windows GitNexus for local CLI providers', () => {
    const previous = process.env['GITNEXUS_WIKI_USE_WSL'];
    delete process.env['GITNEXUS_WIKI_USE_WSL'];
    try {
      if (process.platform === 'win32') {
        expect(gitnexusBinForWiki(['--provider', 'claude'])).toBe('gitnexus.cmd');
      }
    } finally {
      if (previous === undefined) delete process.env['GITNEXUS_WIKI_USE_WSL'];
      else process.env['GITNEXUS_WIKI_USE_WSL'] = previous;
    }
  });
});
