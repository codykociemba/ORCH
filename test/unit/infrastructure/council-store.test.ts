import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CouncilStore } from '../../../src/infrastructure/storage/council-store.js';
import { Paths } from '../../../src/infrastructure/storage/paths.js';

describe('CouncilStore', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'orch-cnc-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('persists votes and verdict', async () => {
    const store = new CouncilStore(new Paths(root));
    const id = store.createId();
    await store.save({
      id,
      plan_id: 'plan_1',
      created_at: '2026-01-01T00:00:00Z',
      rounds: 1,
      votes: [
        { model: 'claude', adapter: 'claude', verdict: 'approve', summary: 'ok' },
        { model: 'gpt', adapter: 'codex', verdict: 'revise', summary: 'tighten reuse' },
      ],
      verdict: 'revise',
      summary: 'Revise reuse section',
    });
    const loaded = await store.get(id);
    expect(loaded?.verdict).toBe('revise');
    expect(loaded?.votes).toHaveLength(2);
    expect((await store.list())[0]?.id).toBe(id);
  });
});
