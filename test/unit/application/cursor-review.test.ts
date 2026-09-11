import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { parseCursorReview, toReviewEvidence } from '../../../src/application/cursor-review.js';
import { copyWorkflowCiTemplates } from '../../../src/cli/commands/workflow.js';
import { readYaml } from '../../../src/infrastructure/storage/fs-utils.js';
import { Paths } from '../../../src/infrastructure/storage/paths.js';
import { ReviewStore } from '../../../src/infrastructure/storage/review-store.js';
import type { ReviewEvidence } from '../../../src/domain/evidence.js';

describe('parseCursorReview', () => {
  it('approves only a clean approve verdict', () => {
    const result = parseCursorReview('{"verdict":"approve","summary":"ok","blocking_findings":[]}', 'abc123def');
    expect(result.verdict).toBe('approve');
  });

  it('fail-closes on missing JSON', () => {
    expect(parseCursorReview('looks good', 'abc123def').verdict).toBe('failed');
  });

  it('fail-closes when the review is not bound to a commit SHA', () => {
    const result = parseCursorReview('{"verdict":"approve","summary":"ok","blocking_findings":[]}');
    expect(result.verdict).toBe('failed');
    expect(result.summary).toMatch(/no commit SHA/);
  });

  it('downgrades approve when blocking findings exist', () => {
    const result = parseCursorReview('{"verdict":"approve","summary":"nope","blocking_findings":["secret"]}', 'abc123def');
    expect(result.verdict).toBe('changes_requested');
  });

  it('binds the parsed verdict to the exact HEAD SHA', () => {
    const result = parseCursorReview('{"verdict":"approve","summary":"ok","blocking_findings":[]}', 'abc123def');
    expect(result.verdict).toBe('approve');
    expect(result.commit_sha).toBe('abc123def');
  });

  it('keeps blocking findings and plan deviations on stored review evidence', () => {
    const parsed = parseCursorReview(
      '{"verdict":"changes_requested","summary":"gaps","blocking_findings":["no test"],"plan_deviations":["U-04"]}',
      'abc123def',
    );
    const evidence = toReviewEvidence(parsed, { commitSha: 'abc123def' });
    expect((evidence as { blocking_findings?: string[] }).blocking_findings).toEqual(['no test']);
    expect((evidence as { plan_deviations?: string[] }).plan_deviations).toEqual(['U-04']);
  });

  it('stores a failed review when toReviewEvidence is given no SHA', () => {
    const parsed = parseCursorReview('{"verdict":"approve","summary":"ok","blocking_findings":[]}', 'abc123def');
    const evidence = toReviewEvidence({ ...parsed, commit_sha: undefined }, { commitSha: '' });
    expect(evidence.verdict).toBe('failed');
    expect(evidence.commit_sha).toBe('');
    expect(evidence.summary).toMatch(/no commit SHA/);
  });
});

describe('GitHub workflow syntax', () => {
  const workflows = ['cursor-review.yml', 'wiki-publish.yml', 'wiki-preview.yml'];

  it('parses ORCH workflow YAML and keeps Cursor review off fork PRs', () => {
    for (const name of workflows) {
      const raw = readFileSync(path.join(process.cwd(), '.github', 'workflows', name), 'utf8');
      const doc = yaml.load(raw) as { jobs?: Record<string, { if?: string }> };
      expect(doc && typeof doc === 'object').toBe(true);
    }
    const cursor = readFileSync(path.join(process.cwd(), '.github', 'workflows', 'cursor-review.yml'), 'utf8');
    expect(cursor).toContain('github.event.pull_request.head.repo.full_name == github.repository');
    expect(cursor).toContain('secrets.CURSOR_API_KEY');
    expect(cursor).toContain('HEAD_SHA');
    expect(cursor).toContain('scripts/cursor-pr-review.mjs');
    const followUp = readFileSync(path.join(process.cwd(), 'scripts', 'cursor-pr-review.mjs'), 'utf8');
    expect(followUp).toContain('blocking_findings');
    expect(followUp).toContain('plan_deviations');
    expect(followUp).toContain('HEAD_SHA');
    expect(followUp).toContain('no commit SHA');
    expect(followUp).toContain('check-runs');
    expect(followUp).toContain('ORCH Cursor review');
    expect(cursor).toContain('checks: write');
    expect(cursor).not.toMatch(/fork.*CURSOR_API_KEY/i);
    const preview = readFileSync(path.join(process.cwd(), '.github', 'workflows', 'wiki-preview.yml'), 'utf8');
    expect(preview).toContain('github.event.pull_request.head.repo.full_name == github.repository');
    expect(preview).not.toContain('wiki publish');
    expect(preview).toContain('wiki generate');
    expect(preview).toContain('Wiki preview required check failed');
    expect(preview).toContain('INDEX_STATUS');
    expect(preview).toContain('gitnexus-fresh.txt');
    const gitlab = readFileSync(path.join(process.cwd(), '.gitlab-ci-wiki.yml'), 'utf8');
    expect(yaml.load(gitlab) && typeof yaml.load(gitlab) === 'object').toBe(true);
    expect(gitlab).toContain('merge_request_event');
    expect(gitlab).toContain('$CI_DEFAULT_BRANCH');
    expect(gitlab).toContain('Do not publish the project wiki from an MR');
    expect(gitlab).toContain('Wiki preview required check failed');
    expect(gitlab).toContain('wiki generate');
    const publish = readFileSync(path.join(process.cwd(), '.github', 'workflows', 'wiki-publish.yml'), 'utf8');
    expect(publish).toContain('wiki generate');
    expect(publish).toContain('wiki publish');
    expect(publish).not.toContain('hashFiles');
    const doctor = readFileSync(path.join(process.cwd(), 'src', 'application', 'doctor-service.ts'), 'utf8');
    expect(doctor).toContain('wiki-preview.yml');
    expect(doctor).toContain('wiki-publish.yml');
    expect(doctor).toContain('have no Linear issue');
    expect(doctor).toContain('never got an outbox');
    expect(doctor).toContain('conventions.yml');
    expect(doctor).toContain('code_intelligence.required');
    expect(doctor).toContain('doctor-detect-wt');
    expect(doctor).toContain('gitnexus linked worktree');
    expect(doctor).toContain('workflow states');
    expect(doctor).toContain('merge-gate rules live in .orch/workflow.yml');
  });
});

describe('copyWorkflowCiTemplates', () => {
  it('enables admission and required GitNexus on an existing workflow.yml', async () => {
    const root = path.join(tmpdir(), `orch-setup-${Date.now()}`);
    await mkdir(path.join(root, '.orch'), { recursive: true });
    await writeFile(
      path.join(root, '.orch', 'workflow.yml'),
      ['code_admission:', '  enabled: false', 'code_intelligence:', '  provider: gitnexus', ''].join('\n'),
    );
    const pathExists = async (file: string): Promise<boolean> => {
      try {
        await access(file);
        return true;
      } catch {
        return false;
      }
    };
    try {
      await copyWorkflowCiTemplates(root, pathExists);
      const doc = await readYaml<Record<string, unknown>>(path.join(root, '.orch', 'workflow.yml'));
      expect((doc?.['code_intelligence'] as { required?: boolean } | undefined)?.required).toBe(true);
      expect((doc?.['code_admission'] as { enabled?: boolean } | undefined)?.enabled).toBe(true);
      expect((doc?.['code_intelligence'] as { provider?: string } | undefined)?.provider).toBe('gitnexus');
      expect((doc?.['code_intelligence'] as { pdg?: { required_for?: string[] } } | undefined)?.pdg?.required_for).toEqual(
        expect.arrayContaining(['security', 'auth', 'payments', 'concurrency', 'dataflow-sensitive']),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('merges missing conventions.yml keys without overwriting user values', async () => {
    const root = path.join(tmpdir(), `orch-setup-conv-${Date.now()}`);
    await mkdir(path.join(root, '.orch'), { recursive: true });
    await writeFile(
      path.join(root, '.orch', 'conventions.yml'),
      ['version: 1', 'organization:', '  max_new_files_per_task: 2', 'comments:', '  header_max_lines: 6', ''].join('\n'),
    );
    const pathExists = async (file: string): Promise<boolean> => {
      try {
        await access(file);
        return true;
      } catch {
        return false;
      }
    };
    try {
      await copyWorkflowCiTemplates(root, pathExists);
      const doc = await readYaml<Record<string, unknown>>(path.join(root, '.orch', 'conventions.yml'));
      const org = doc?.['organization'] as Record<string, unknown> | undefined;
      const comments = doc?.['comments'] as Record<string, unknown> | undefined;
      expect(doc?.['version']).toBe(1);
      expect(org?.['max_new_files_per_task']).toBe(2);
      expect(org?.['no_parallel_utils']).toBe(true);
      expect(comments?.['header_max_lines']).toBe(6);
      expect(comments?.['no_jsdoc_on_functions']).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('copies wiki and cursor CI templates from the package root', async () => {
    const root = path.join(tmpdir(), `orch-setup-ci-${Date.now()}`);
    await mkdir(path.join(root, '.orch'), { recursive: true });
    const pathExists = async (file: string): Promise<boolean> => {
      try {
        await access(file);
        return true;
      } catch {
        return false;
      }
    };
    try {
      await copyWorkflowCiTemplates(root, pathExists);
      await access(path.join(root, '.github', 'workflows', 'wiki-preview.yml'));
      await access(path.join(root, '.github', 'workflows', 'wiki-publish.yml'));
      await access(path.join(root, '.github', 'workflows', 'cursor-review.yml'));
      await access(path.join(root, '.github', 'cursor-review-prompt.md'));
      await access(path.join(root, 'scripts', 'cursor-pr-review.mjs'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('ReviewStore duplicate webhook delivery', () => {
  it('replaces the same SHA + reviewer instead of appending a second review', async () => {
    const root = path.join(tmpdir(), `orch-review-dup-${Date.now()}`);
    const store = new ReviewStore(new Paths(root));
    const first: ReviewEvidence = {
      reviewer_type: 'cursor',
      reviewer: 'cursor-cli',
      commit_sha: 'abc123def',
      verdict: 'approve',
      summary: 'first delivery',
      timestamp: 't1',
    };
    const replay: ReviewEvidence = {
      ...first,
      summary: 'duplicate webhook',
      timestamp: 't2',
    };
    try {
      await store.append('tsk_1', first);
      const next = await store.append('tsk_1', replay);
      expect(next).toHaveLength(1);
      expect(next[0]?.summary).toBe('duplicate webhook');
      expect(next[0]?.commit_sha).toBe('abc123def');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
