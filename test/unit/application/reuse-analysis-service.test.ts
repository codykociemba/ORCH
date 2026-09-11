import { describe, it, expect } from 'vitest';
import { ReuseAnalysisService } from '../../../src/application/reuse-analysis-service.js';
import type { ICodeIntelligence } from '../../../src/infrastructure/code-intelligence/interface.js';

function mockIntel(hits: Array<{ path: string; symbol?: string }>): ICodeIntelligence {
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
    getProcesses: async () => [],
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
    expect(result.proposed_creates).toEqual([]);
  });

  it('proposes a create only when GitNexus has no candidate', async () => {
    const service = new ReuseAnalysisService(mockIntel([]), '/repo');
    const result = await service.analyze({ queries: ['brandNewHelper'] });
    expect(result.proposed_creates).toEqual([
      expect.objectContaining({ kind: 'symbol', name: 'brandNewHelper' }),
    ]);
  });
});
