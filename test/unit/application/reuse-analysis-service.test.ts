import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ReuseAnalysisService } from '../../../src/application/reuse-analysis-service.js';
import type { ICodeIntelligence } from '../../../src/infrastructure/code-intelligence/interface.js';

function mockIntel(hits: Array<{ path: string; symbol?: string; score?: number; snippet?: string }>): ICodeIntelligence {
  return {
    getRepositoryStatus: async () => ({
      provider: 'gitnexus',
      repo: 't',
      available: true,
      current: true,
      incomplete_reasons: [],
    }),
    searchExisting: async () => hits,
    getSymbolContext: async () => ({ symbol: 'x', callers: [], callees: [], processes: [] }),
    getImpact: async () => ({
      target: 'x', risk: 'low', direct_dependents: 0, total_dependents: 0, processes: [], unresolved: false,
    }),
    getProcesses: async () => [{ name: 'RetryFlow', steps: ['src/application/orchestrator.ts', 'enqueueRetry'] }],
    detectChanges: async () => ({
      added_symbols: [], modified_symbols: [], deleted_symbols: [], processes: [],
      partial: false, truncated: false, degraded: false, worktree: '',
    }),
  };
}

describe('ReuseAnalysisService', () => {
  it('recommends edits for strong hits and does not invent those creates', async () => {
    const service = new ReuseAnalysisService(mockIntel([{ path: 'src/retry.ts', symbol: 'retry', score: 0.9 }]), '/repo');
    const result = await service.analyze({ queries: ['retry'] });
    expect(result.recommended_edits[0]?.symbol).toBe('retry');
    expect(result.candidates.some((item) => item.decision === 'reuse')).toBe(true);
    expect(result.candidates.some((item) => item.kind === 'process' && item.symbol === 'RetryFlow' && item.path === 'src/application/orchestrator.ts')).toBe(true);
    expect(result.proposed_creates).toEqual([]);
  });

  it('reads on-disk admission reservations even when GitNexus search is empty', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orch-reuse-ledger-'));
    try {
      await mkdir(path.join(root, '.orchestry', 'admission'), { recursive: true });
      await writeFile(path.join(root, '.orchestry', 'admission', 'reservations.json'), JSON.stringify({
        version: 1,
        items: [{
          key: 'symbol:src/reserved-helper.ts:reservedHelper',
          kind: 'symbol',
          path: 'src/reserved-helper.ts',
          name: 'reservedHelper',
          task_id: 'tsk_owner',
          created_at: '2026-01-01T00:00:00Z',
        }],
      }));
      const result = await new ReuseAnalysisService(mockIntel([]), root).analyze({ queries: ['reservedHelper'] });
      expect(result.candidates.some((item) => (
        item.symbol === 'reservedHelper' && item.reason.includes('Admission ledger reservation')
      ))).toBe(true);
      expect(result.proposed_creates).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('treats admission ledger reservations as existing code, not new creates', async () => {
    const service = new ReuseAnalysisService(mockIntel([{
      path: 'src/reserved-helper.ts',
      symbol: 'reservedHelper',
      score: 1,
      snippet: 'reserved by tsk_owner',
    }]), '/repo');
    const result = await service.analyze({ queries: ['reservedHelper'] });
    expect(result.candidates.some((item) => item.symbol === 'reservedHelper' && item.reason.includes('Admission ledger reservation'))).toBe(true);
    expect(result.proposed_creates).toEqual([]);
  });

  it('searches goal titles without proposing them as new symbols', async () => {
    const service = new ReuseAnalysisService(mockIntel([]), '/repo');
    const result = await service.analyze({
      queries: ['Retry customer cancellation after billing failure', 'brandNewHelper'],
    });
    expect(result.searches).toContain('Retry customer cancellation after billing failure');
    expect(result.proposed_creates.some((item) => item.name === 'brandNewHelper')).toBe(true);
    expect(result.proposed_creates.some((item) => (item.name ?? '').includes('cancellation'))).toBe(false);
  });

  it('proposes a create only when GitNexus has no candidate', async () => {
    const service = new ReuseAnalysisService(mockIntel([]), '/repo');
    const result = await service.analyze({ queries: ['brandNewHelper'] });
    expect(result.proposed_creates).toEqual([
      expect.objectContaining({ kind: 'symbol', name: 'brandNewHelper' }),
    ]);
  });

  it('attaches GitNexus blast radius and does not treat HIGH impact as automatic reuse', async () => {
    const intel = mockIntel([{ path: 'src/retry.ts', symbol: 'retry', score: 0.9 }]);
    intel.getImpact = async () => ({
      target: 'retry',
      risk: 'high',
      direct_dependents: 4,
      total_dependents: 9,
      processes: ['RetryFlow'],
      unresolved: false,
    });
    const result = await new ReuseAnalysisService(intel, '/repo').analyze({ queries: ['retry'] });
    const hit = result.candidates.find((item) => item.symbol === 'retry');
    expect(hit?.decision).toBe('investigate');
    expect(hit?.reason).toContain('impact HIGH');
    expect(hit?.reason).toContain('4 dependents');
    expect(hit?.reason).toContain('RetryFlow');
    expect(result.recommended_edits.some((item) => item.symbol === 'retry')).toBe(false);
  });

  it('marks reuse incomplete when impact is UNKNOWN', async () => {
    const intel = mockIntel([{ path: 'src/retry.ts', symbol: 'retry', score: 0.9 }]);
    intel.getImpact = async () => ({
      target: 'retry',
      risk: 'unknown',
      direct_dependents: 0,
      total_dependents: 0,
      processes: [],
      unresolved: true,
    });
    const result = await new ReuseAnalysisService(intel, '/repo').analyze({ queries: ['retry'] });
    expect(result.incomplete).toBe(true);
    expect(result.reasons.some((item) => item.includes('UNKNOWN impact'))).toBe(true);
    expect(result.recommended_edits.some((item) => item.symbol === 'retry')).toBe(false);
  });

  it('recovers GitNexus 1.6 process/label objects when impact.processes is empty', async () => {
    const intel = mockIntel([{ path: 'src/retry.ts', symbol: 'retry', score: 0.9 }]);
    intel.getImpact = async () => ({
      target: 'retry',
      risk: 'low',
      direct_dependents: 1,
      total_dependents: 1,
      processes: [],
      unresolved: false,
      raw: { affected_processes: [{ process: 'RetryFlow' }] },
    });
    const result = await new ReuseAnalysisService(intel, '/repo').analyze({ queries: ['retry'] });
    expect(result.candidates.find((item) => item.symbol === 'retry')?.reason).toContain('RetryFlow');
  });

  it('does not authorize creates when PDG-sensitive reuse cannot run analyze --pdg', async () => {
    const service = new ReuseAnalysisService(mockIntel([]), '/repo');
    const result = await service.analyze({ queries: ['auth refresh helper'] });
    expect(result.incomplete).toBe(true);
    expect(result.reasons.some((item) => /PDG required/i.test(item))).toBe(true);
    expect(result.proposed_creates).toEqual([]);
  });

  it('requests PDG analyze for payments reuse when the adapter can run it', async () => {
    const intel = mockIntel([]);
    const seen: unknown[] = [];
    intel.analyze = async (input) => {
      seen.push(input);
    };
    const result = await new ReuseAnalysisService(intel, '/repo').analyze({ queries: ['payments webhook'] });
    expect(seen).toEqual([expect.objectContaining({ pdg: true, repository_root: '/repo' })]);
    expect(result.reasons.some((item) => /PDG analyze requested/i.test(item))).toBe(true);
    expect(result.incomplete).toBe(false);
  });
});
