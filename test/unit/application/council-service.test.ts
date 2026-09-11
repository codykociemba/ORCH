import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CouncilService } from '../../../src/application/council-service.js';
import { CouncilStore } from '../../../src/infrastructure/storage/council-store.js';
import { Paths } from '../../../src/infrastructure/storage/paths.js';
import { EventBus } from '../../../src/application/event-bus.js';
import type { IAgentAdapter, AgentEvent, ExecuteParams } from '../../../src/infrastructure/adapters/interface.js';
import type { PlanManifest } from '../../../src/domain/plan.js';

function adapter(kind: string, ...jsons: string[]): IAgentAdapter {
  let call = 0;
  return {
    kind,
    test: async () => ({ ok: true }),
    execute: () => {
      const text = jsons[Math.min(call, jsons.length - 1)] ?? '{}';
      call += 1;
      return {
        pid: 1,
        events: (async function* (): AsyncGenerator<AgentEvent> {
          yield { type: 'done', timestamp: 't', data: { text } };
        })(),
      };
    },
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
    candidates: [
      { path: 'src/retry.ts', relevance: 'high', decision: 'reuse', reason: 'exists' },
      { path: 'process', symbol: 'RetryFlow', kind: 'process', relevance: 'medium', decision: 'investigate', reason: 'process' },
    ],
    recommended_edits: [],
    proposed_creates: [{
      kind: 'file',
      path: 'src/retry-audit.ts',
      why_not_reuse: 'no existing audit sink',
      alternatives_considered: ['src/retry.ts'],
    }],
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

  it('approves only when every invited member approves', async () => {
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
    expect(result.gitnexus_evidence?.candidates).toContain('process:RetryFlow');
    expect(result.gitnexus_evidence?.candidates.some((item) => item.startsWith('create:file:src/retry-audit.ts'))).toBe(true);
    expect(result.plan_digest).toBe('pln_1');
    expect(result.rounds).toBe(1);
    const bus = new EventBus();
    const refreshed: string[] = [];
    bus.onAny((event) => {
      if (event.type === 'learning:refreshed') refreshed.push(event.type);
    });
    const withBus = new CouncilService(
      new CouncilStore(new Paths(root)),
      (kind) => adapters[kind],
      root,
      180_000,
      bus,
    );
    await withBus.convene({ plan });
    expect(refreshed).toContain('learning:refreshed');
  });

  it('runs a second independent round after a first-pass revise', async () => {
    const adapters: Record<string, IAgentAdapter> = {
      claude: adapter(
        'claude',
        '{"status":"rejected","reason":"need more reuse"}',
        '{"status":"approved","reason":"reuse is enough after changelog"}',
      ),
      codex: adapter(
        'codex',
        '{"status":"approved","reason":"ok"}',
        '{"status":"approved","reason":"still ok"}',
      ),
      cursor: adapter(
        'cursor',
        '{"status":"approved","reason":"ok"}',
        '{"status":"approved","reason":"ok"}',
      ),
    };
    const service = new CouncilService(
      new CouncilStore(new Paths(root)),
      (kind) => adapters[kind],
      root,
    );
    const result = await service.convene({ plan });
    expect(result.rounds).toBe(2);
    expect(result.votes).toHaveLength(6);
    expect(result.verdict).toBe('approve');
    expect(result.votes.filter((vote) => vote.round === 1).some((vote) => vote.verdict === 'reject')).toBe(true);
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
    expect(result.verdict).toBe('approve');
    expect(result.votes[0]?.verdict).toBe('approve');
    expect(result.votes[0]?.summary).toContain('nested cursor json');
  });

  it('parses a verdict from a Claude result envelope', async () => {
    const adapters: Record<string, IAgentAdapter> = {
      claude: {
        kind: 'claude',
        test: async () => ({ ok: true }),
        execute: () => ({
          pid: 1,
          events: (async function* (): AsyncGenerator<AgentEvent> {
            yield {
              type: 'done',
              timestamp: 't',
              data: {
                type: 'result',
                result: '{"status":"approved","reason":"envelope"}',
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
      members: [{ adapter: 'claude', model: 'claude' }],
    });
    expect(result.votes[0]?.verdict).toBe('approve');
    expect(result.votes[0]?.summary).toContain('envelope');
  });

  it('fail-closed revise when an adapter is missing', async () => {
    const bus = new EventBus();
    const events: string[] = [];
    bus.onAny((event) => { events.push(event.type); });
    const service = new CouncilService(
      new CouncilStore(new Paths(root)),
      () => undefined,
      root,
      1_000,
      bus,
    );
    const result = await service.convene({
      plan,
      members: [{ adapter: 'claude', model: 'claude' }],
    });
    expect(result.verdict).toBe('revise');
    expect(result.votes[0]?.summary).toMatch(/not available/);
    expect(events).toContain('planning:council_started');
    expect(events).toContain('planning:council_blocked');
    expect(events).toContain('planning:council_completed');
  });

  it('does not approve when one required member is missing even if two approve', async () => {
    const adapters: Record<string, IAgentAdapter> = {
      claude: adapter('claude', '{"status":"approved","reason":"ok"}'),
      codex: adapter('codex', '{"status":"approved","reason":"ok"}'),
    };
    const service = new CouncilService(
      new CouncilStore(new Paths(root)),
      (kind) => adapters[kind],
      root,
    );
    const result = await service.convene({ plan });
    expect(result.verdict).toBe('revise');
    expect(result.votes.some((vote) => vote.summary.includes('not available'))).toBe(true);
  });

  it('sends GitNexus impact and rejected alternatives to each member', async () => {
    let prompt = '';
    const adapters: Record<string, IAgentAdapter> = {
      claude: {
        kind: 'claude',
        test: async () => ({ ok: true }),
        execute: (params: ExecuteParams) => {
          prompt = params.prompt;
          return adapter('claude', '{"status":"approved","reason":"ok"}').execute(params);
        },
        stop: async () => {},
      },
    };
    const service = new CouncilService(
      new CouncilStore(new Paths(root)),
      (kind) => adapters[kind],
      root,
    );
    const withImpact: PlanManifest = {
      ...plan,
      reuse: {
        ...plan.reuse,
        candidates: [
          {
            path: 'src/retry.ts',
            symbol: 'retry',
            relevance: 'high',
            decision: 'investigate',
            reason: 'GitNexus hit (impact HIGH, 4 dependents, processes: RetryFlow)',
          },
        ],
      },
    };
    await service.convene({
      plan: withImpact,
      members: [{ adapter: 'claude', model: 'claude' }],
    });
    expect(prompt).toContain('Impact:');
    expect(prompt).toContain('impact HIGH');
    expect(prompt).toContain('4 dependents');
    expect(prompt).toContain('RetryFlow');
    expect(prompt).toContain('alts=src/retry.ts');
  });

  it('marks council GitNexus evidence incomplete when impact is UNKNOWN', async () => {
    const adapters: Record<string, IAgentAdapter> = {
      claude: adapter('claude', '{"status":"approved","reason":"ok"}'),
    };
    const service = new CouncilService(
      new CouncilStore(new Paths(root)),
      (kind) => adapters[kind],
      root,
    );
    const result = await service.convene({
      plan: {
        ...plan,
        reuse: {
          ...plan.reuse,
          incomplete: false,
          candidates: [{
            path: 'src/retry.ts',
            symbol: 'retry',
            relevance: 'high',
            decision: 'investigate',
            reason: 'GitNexus hit (impact UNKNOWN, 0 dependents, processes: none)',
          }],
        },
      },
      members: [{ adapter: 'claude', model: 'claude' }],
    });
    expect(result.gitnexus_evidence?.incomplete).toBe(true);
    expect(result.gitnexus_evidence?.candidates?.some((item) => item.includes('impact UNKNOWN'))).toBe(true);
  });

  it('records a computed plan digest when the imported plan omitted one', async () => {
    const { planDigest } = await import('../../../src/domain/plan.js');
    const adapters: Record<string, IAgentAdapter> = {
      claude: adapter('claude', '{"status":"approved","reason":"ok"}'),
    };
    const service = new CouncilService(
      new CouncilStore(new Paths(root)),
      (kind) => adapters[kind],
      root,
    );
    const result = await service.convene({
      plan: { ...plan, digest: '' },
      members: [{ adapter: 'claude', model: 'claude' }],
    });
    expect(result.plan_digest).toBe(planDigest(plan.title, plan.units));
    expect(result.plan_digest).toMatch(/^pln_/);
  });
});
