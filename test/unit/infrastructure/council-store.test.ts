import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
      plan_digest: 'pln_abc',
      human_override: {
        reason: 'unblock after member outage',
        at: '2026-01-02T00:00:00Z',
        actor: 'human',
        task_ids: ['tsk_1'],
      },
    });
    const loaded = await store.get(id);
    expect(loaded?.verdict).toBe('revise');
    expect(loaded?.votes).toHaveLength(2);
    expect((await store.list())[0]?.id).toBe(id);

    const paths = new Paths(root);
    const report = JSON.parse(await readFile(paths.councilPlanJsonPath('plan_1'), 'utf8')) as { id: string };
    expect(report.id).toBe(id);
    const markdown = await readFile(paths.councilPlanMarkdownPath('plan_1'), 'utf8');
    expect(markdown).toContain('## Round 1');
    expect(markdown).toContain('## Strongest objections');
    expect(markdown).toContain('## Human override');
    expect(markdown).toContain('unblock after member outage');
    expect(markdown).toContain('pln_abc');
    expect(markdown).toContain('human override unlocks dispatch');
    expect(markdown).toContain('Not approved');
  });
});
