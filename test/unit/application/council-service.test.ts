import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CouncilService } from '../../../src/application/council-service.js';
import { CouncilStore } from '../../../src/infrastructure/storage/council-store.js';
import { Paths } from '../../../src/infrastructure/storage/paths.js';
import type { IAgentAdapter, AgentEvent } from '../../../src/infrastructure/adapters/interface.js';
import type { PlanManifest } from '../../../src/domain/plan.js';

function adapter(kind: string, json: string): IAgentAdapter {
  return {
    kind,
    test: async () => ({ ok: true }),
    execute: () => ({
      pid: 1,
      events: (async function* (): AsyncGenerator<AgentEvent> {
        yield { type: 'done', timestamp: 't', data: { text: json } };
      })(),
    }),
    stop: async () => {},
  };
}

const plan: PlanManifest = {
  version: 1,
  id: 'plan_c1',
  title: 'Retry',
  digest: 'pln_1',
  units: [{ id: 'u1', title: 'A', depends_on: [], acceptance_criteria: [] }],
  route: 'council_required',
  reuse: {
    searches: ['retry'],
    candidates: [{ path: 'src/retry.ts', relevance: 'high', decision: 'reuse', reason: 'exists' }],
    recommended_edits: [],
    proposed_creates: [],
    incomplete: false,
    reasons: [],
  },
  council_required: true,
  created_at: '2026-01-01T00:00:00Z',
};

describe('CouncilService', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'orch-cnc-run-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('approves when two members approve and none reject', async () => {
    const adapters: Record<string, IAgentAdapter> = {
      claude: adapter('claude', '{"status":"approved","reason":"reuse retry"}'),
      codex: adapter('codex', '{"status":"approved","reason":"agree"}'),
      cursor: adapter('cursor', '{"status":"approved","reason":"agree"}'),
    };
    const service = new CouncilService(
      new CouncilStore(new Paths(root)),
      (kind) => adapters[kind],
      root,
    );
    const result = await service.convene({ plan });
    expect(result.verdict).toBe('approve');
    expect(result.votes).toHaveLength(3);
    expect(result.votes.map((vote) => vote.adapter)).toEqual(['claude', 'codex', 'cursor']);
    expect(result.votes[2]?.model).toBe('grok-4.6');
    expect(result.gitnexus_evidence?.searches).toContain('retry');
  });

  it('reads a JSON verdict out of a Cursor-style nested assistant message', async () => {
    const adapters: Record<string, IAgentAdapter> = {
      cursor: {
        kind: 'cursor',
        test: async () => ({ ok: true }),
        execute: () => ({
          pid: 1,
          events: (async function* (): AsyncGenerator<AgentEvent> {
            yield {
              type: 'output',
              timestamp: 't',
              data: {
                role: 'assistant',
                content: [{ type: 'text', text: '{"status":"approved","reason":"nested cursor json"}' }],
              },
            };
          })(),
        }),
        stop: async () => {},
      },
    };
    const service = new CouncilService(
      new CouncilStore(new Paths(root)),
      (kind) => adapters[kind],
      root,
    );
    const result = await service.convene({
      plan,
      members: [{ adapter: 'cursor', model: 'grok-4.6' }],
    });
    expect(result.verdict).toBe('revise');
    expect(result.votes[0]?.verdict).toBe('approve');
    expect(result.votes[0]?.summary).toContain('nested cursor json');
  });

  it('fail-closed revise when an adapter is missing', async () => {
    const service = new CouncilService(
      new CouncilStore(new Paths(root)),
      () => undefined,
      root,
    );
    const result = await service.convene({
      plan,
      members: [{ adapter: 'claude', model: 'claude' }],
    });
    expect(result.verdict).toBe('revise');
    expect(result.votes[0]?.summary).toMatch(/not available/);
  });
});
