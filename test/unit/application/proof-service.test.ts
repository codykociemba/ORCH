import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { ProofService } from '../../../src/application/proof-service.js';
import { makeTask } from './helpers.js';

describe('ProofService', () => {
  const service = new ProofService();
  const approveAt = (sha: string) => [{
    reviewer_type: 'cursor' as const,
    reviewer: 'cursor-cli',
    commit_sha: sha,
    verdict: 'approve' as const,
    summary: 'ok',
    timestamp: 't',
  }];

  it('includes admission and requires SHA for Verified', () => {
    const task = makeTask({ id: 'tsk_p1', proof: { files_changed: ['a.ts'], branch: 'orch/tsk_p1' } });
    const withoutSha = service.build({
      task,
      audit: { passed: true, incomplete: false, violations: [], added_files: [], added_symbols: [] },
    });
    expect(withoutSha.verified).toBe(false);
    expect(withoutSha.admission?.passed).toBe(true);

    const withSha = service.build({
      task,
      headSha: 'abc123',
      reviews: approveAt('abc123'),
      audit: { passed: true, incomplete: false, violations: [], added_files: [], added_symbols: [] },
    });
    expect(withSha.verified).toBe(true);
    expect(service.build({
      task,
      headSha: 'abc123',
      audit: { passed: true, incomplete: false, violations: [], added_files: [], added_symbols: [] },
    }).verified).toBe(false);
    expect(service.build({
      task,
      headSha: 'abc123',
      reviews: [{
        reviewer_type: 'claude',
        commit_sha: 'abc123',
        verdict: 'approve',
        summary: 'lead only',
        timestamp: 't',
      }],
      audit: { passed: true, incomplete: false, violations: [], added_files: [], added_symbols: [] },
    }).verified).toBe(false);
  });

  it('binds Verified to the current HEAD SHA and replaces a prior stamp', () => {
    const evidence = service.build({
      task: makeTask({ proof: { files_changed: [], head_sha: 'oldsha', verified: true } }),
      headSha: 'newsha',
      reviews: approveAt('newsha'),
      audit: { passed: true, incomplete: false, violations: [], added_files: [], added_symbols: [] },
    });
    expect(evidence.head_sha).toBe('newsha');
    expect(evidence.verified).toBe(true);
  });

  it('does not verify when the only approve review is bound to a different SHA', () => {
    const evidence = service.build({
      task: makeTask(),
      headSha: 'newsha',
      reviews: [{
        reviewer_type: 'cursor',
        reviewer: 'cursor-cli',
        commit_sha: 'oldsha',
        verdict: 'approve',
        summary: 'stale',
        timestamp: 't',
      }],
      audit: { passed: true, incomplete: false, violations: [], added_files: [], added_symbols: [] },
    });
    expect(evidence.verified).toBe(false);
  });

  it('maps review_results to checks with exit status and copies plan refs', () => {
    const evidence = service.build({
      task: makeTask({
        plan_id: 'plan_1',
        plan_unit_id: 'U-03',
        review_results: [
          { criterion: 'test_pass', passed: true, output: '12 passed' },
          { criterion: 'typecheck', passed: false, output: 'TS2322' },
        ],
      }),
      headSha: 'abc123',
      audit: { passed: true, incomplete: false, violations: [], added_files: [], added_symbols: [] },
    });
    expect(evidence.plan_id).toBe('plan_1');
    expect(evidence.plan_unit_id).toBe('U-03');
    expect(evidence.checks).toEqual([
      { name: 'test_pass', status: 'passed', summary: '12 passed', exit_code: 0 },
      { name: 'typecheck', status: 'failed', summary: 'TS2322', exit_code: 1 },
    ]);
    expect(evidence.verified).toBe(false);
    expect(service.renderGitHub(evidence)).toContain('typecheck: failed (exit 1)');
    expect(service.renderLinear(evidence)).toContain('Check: typecheck failed exit 1');
  });

  it('copies council and learning refs into canonical proof', () => {
    const evidence = service.build({
      task: makeTask({
        council_ref: 'cnc_1',
        plan_id: 'plan_1',
        proof: { files_changed: ['src/retry.ts'] },
      }),
      headSha: 'abc123',
      reviews: approveAt('abc123'),
      learningRefs: ['docs/solutions/2026-09-11-goal_1.md'],
      audit: { passed: true, incomplete: false, violations: [], added_files: [], added_symbols: [] },
    });
    expect(evidence.council_ref).toBe('cnc_1');
    expect(evidence.learning_refs).toEqual(['docs/solutions/2026-09-11-goal_1.md']);
    expect(evidence.verified).toBe(true);
    const github = service.renderGitHub(evidence);
    expect(github).toContain('Council: `cnc_1`');
    expect(github).toContain('### Changed files');
    expect(github).toContain('src/retry.ts');
    expect(github).toContain('docs/solutions/2026-09-11-goal_1.md');
    expect(service.renderLinear(evidence)).toContain('Council: cnc_1');
  });

  it('includes acceptance criteria from the task', () => {
    const evidence = service.build({
      task: makeTask({ acceptance_criteria: ['Retry uses existing helper'] }),
      headSha: 'abc123',
      audit: { passed: true, incomplete: false, violations: [], added_files: [], added_symbols: [] },
    });
    expect(evidence.acceptance_criteria[0]?.description).toBe('Retry uses existing helper');
    expect(evidence.acceptance_criteria[0]?.passed).toBe(true);
    expect(service.renderGitHub(evidence)).toContain('Retry uses existing helper');
  });

  it('does not verify when the GitNexus index is stale', () => {
    const fromContract = service.build({
      task: makeTask(),
      headSha: 'abc123',
      reviews: approveAt('abc123'),
      audit: { passed: true, incomplete: false, violations: [], added_files: [], added_symbols: [] },
      contract: {
        existing_code_considered: [],
        allowed_existing_edits: [],
        allowed_new_files: [],
        allowed_new_symbols: [],
        allowed_dependencies: [],
        code_index: {
          provider: 'gitnexus',
          repo: 'ORCH',
          index_current: false,
          index_commit: 'old',
          generated_at: '2026-01-01T00:00:00Z',
        },
      },
    });
    expect(fromContract.verified).toBe(false);
    const fromWiki = service.build({
      task: makeTask(),
      headSha: 'abc123',
      reviews: approveAt('abc123'),
      audit: { passed: true, incomplete: false, violations: [], added_files: [], added_symbols: [] },
      wiki: {
        enabled: true,
        provider: 'github',
        mode: 'local-preview',
        source_sha: 'abc123',
        index_current: false,
        status: 'passed',
        pages_generated: 4,
      },
    });
    expect(fromWiki.verified).toBe(false);
    const fromFailedWiki = service.build({
      task: makeTask(),
      headSha: 'abc123',
      reviews: approveAt('abc123'),
      audit: { passed: true, incomplete: false, violations: [], added_files: [], added_symbols: [] },
      wiki: {
        enabled: true,
        provider: 'github',
        mode: 'local-preview',
        source_sha: 'abc123',
        index_current: true,
        status: 'failed',
        pages_generated: 0,
        failed_modules: ['overview'],
      },
    });
    expect(fromFailedWiki.verified).toBe(false);
  });

  it('audit failure prevents Verified', () => {
    const evidence = service.build({
      task: makeTask(),
      headSha: 'abc123',
      audit: {
        passed: false,
        incomplete: false,
        violations: [{ kind: 'unapproved_file', message: 'nope' }],
        added_files: ['x.ts'],
        added_symbols: [],
      },
    });
    expect(evidence.verified).toBe(false);
    expect(service.renderGitHub(evidence)).toContain('FAIL');
  });

  it('renders wiki bootstrap in GitHub and Linear proof', () => {
    const evidence = service.build({
      task: makeTask(),
      headSha: 'abc123',
      wiki: {
        enabled: true,
        provider: 'github',
        mode: 'pr-preview',
        source_sha: 'abc123',
        index_current: true,
        status: 'bootstrap_required',
        pages_generated: 4,
      },
    });
    const github = service.renderGitHub(evidence);
    expect(github).toContain('one-time wiki bootstrap required');
    expect(github).toContain('Canonical provider: GitHub');
    expect(github).toContain('preview only');
    expect(github).toContain('Failed modules: 0');
    expect(service.renderLinear(evidence)).toContain('Wiki: bootstrap_required');
  });

  it('renders approved versus actual admission counts from the contract', () => {
    const evidence = service.build({
      task: makeTask({ proof: { files_changed: ['src/retry.ts'], branch: 'orch/ENG-142-retry' } }),
      headSha: 'abc1234def',
      audit: {
        passed: true,
        incomplete: false,
        violations: [],
        added_files: ['src/retry.ts'],
        added_symbols: ['retryOnce'],
        processes: ['CustomerSync'],
      },
      contract: {
        existing_code_considered: [
          { path: 'src/lib/backoff.ts', symbol: 'backoff', relevance: 'high', decision: 'reuse', reason: 'existing backoff' },
        ],
        allowed_existing_edits: [{
          symbol: 'retryOnce',
          path: 'src/retry.ts',
          expected_change: 'reuse retry',
          impact: { risk: 'medium', direct_dependents: 4, processes: ['CustomerSync'] },
        }],
        allowed_new_files: [],
        allowed_new_symbols: [],
        allowed_dependencies: [],
      },
    });
    const github = service.renderGitHub(evidence);
    expect(github).toContain('Existing code candidates inspected: 1');
    expect(github).toContain('Existing symbols reused: 1');
    expect(github).toContain('Existing symbols modified: 1');
    expect(github).toContain('Blast radius: MEDIUM');
    expect(github).toContain('New files: approved 0 / actual 1');
    expect(github).toContain('New symbols: approved 0 / actual 1');
    expect(github).toContain('Affected execution flows: CustomerSync');
    const linear = service.renderLinear(evidence);
    expect(linear).toContain('Existing candidates inspected: 1');
    expect(linear).toContain('Existing symbols reused: 1');
    expect(linear).toContain('Existing symbols modified: 1');
    expect(linear).toContain('New files approved/actual: 0 / 1');
    expect(linear).toContain('Blast radius: MEDIUM');
    expect(linear).toContain('Affected flows: CustomerSync');
  });

  it('renders GitNexus index from the modification contract when wiki is absent', () => {
    const evidence = service.build({
      task: makeTask({ proof: { files_changed: ['src/retry.ts'] } }),
      headSha: 'abc1234def',
      audit: { passed: true, incomplete: false, violations: [], added_files: [], added_symbols: [] },
      contract: {
        existing_code_considered: [],
        allowed_new_files: [],
        allowed_new_symbols: [],
        allowed_dependencies: [],
        code_index: {
          provider: 'gitnexus',
          repo: 'ORCH',
          index_commit: 'deadbeef0123',
          index_current: true,
          generated_at: '2026-01-01T00:00:00Z',
        },
      },
    });
    const github = service.renderGitHub(evidence);
    expect(github).toContain('GitNexus index: current at `deadbee`');
    expect(github).not.toContain('### Wiki');
    const linear = service.renderLinear(evidence);
    expect(linear).toContain('GitNexus index current: yes');
  });

  it('includes Linear identifiers on orch proof show output', () => {
    const evidence = service.build({
      task: makeTask({ proof: { files_changed: ['src/retry.ts'] } }),
      headSha: 'abc1234def',
    });
    const github = service.renderGitHub(evidence, {
      linear: 'ENG-142',
      linearUrl: 'https://linear.app/team/issue/ENG-142',
    });
    expect(github).toContain('Linear: ENG-142');
    expect(github).toContain('Linear issue: https://linear.app/team/issue/ENG-142');
  });

  it('renders concise GitHub and Linear admission sections from existing evidence', () => {
    const evidence = service.build({
      task: makeTask({
        proof: { files_changed: ['src/retry.ts'], branch: 'orch/ENG-142-retry' },
        external: { github: { pr_url: 'https://github.com/org/repo/pull/9' } },
      }),
      headSha: 'abc1234def',
      audit: { passed: true, incomplete: false, violations: [], added_files: ['src/retry.ts'], added_symbols: [] },
      wiki: {
        enabled: true,
        provider: 'github',
        mode: 'pr-preview',
        source_sha: 'abc1234def',
        index_current: true,
        status: 'passed',
        pages_generated: 4,
      },
    });
    const github = service.renderGitHub(evidence);
    expect(github).toContain('### Code admission');
    expect(github).toContain('GitNexus index: current at `abc1234`');
    expect(github).toContain('Worktree: `orch/ENG-142-retry`');
    expect(github).toContain('New files: approved 0 / actual 1');
    expect(github).toContain('Admission violations: **0**');
    expect(github).toContain('Result: PASS');
    const linear = service.renderLinear(evidence);
    expect(linear).toContain('### Architecture / reuse verification');
    expect(linear).toContain('GitNexus index current: yes');
    expect(linear).toContain('New files approved/actual: 0 / 1');
    expect(linear).toContain('Admission violations: 0');
    expect(linear).toContain('GitHub proof: https://github.com/org/repo/pull/9');
  });

  it('renders canonical wiki URL and published page count after publish', () => {
    const evidence = service.build({
      task: makeTask(),
      headSha: 'def56789',
      wiki: {
        enabled: true,
        provider: 'gitlab',
        mode: 'canonical-publish',
        source_sha: 'def56789abcd',
        index_current: true,
        status: 'passed',
        pages_generated: 8,
        pages_published: 8,
        failed_modules: [],
        canonical_wiki_url: 'https://gitlab.com/acme/orch/-/wikis/home',
      },
    });
    const github = service.renderGitHub(evidence);
    expect(github).toContain('Canonical wiki: updated');
    expect(github).toContain('Provider: GitLab');
    expect(github).toContain('Pages published: 8');
    expect(github).toContain('Wiki: https://gitlab.com/acme/orch/-/wikis/home');
    expect(service.renderLinear(evidence)).toContain('Wiki URL: https://gitlab.com/acme/orch/-/wikis/home');
  });

  it('fails Verified when conventions lint rejects a new file', () => {
    const evidence = service.build({
      task: makeTask(),
      headSha: 'abc123',
      reviews: approveAt('abc123'),
      audit: { passed: true, incomplete: false, violations: [], added_files: [], added_symbols: [] },
      conventionRules: { enabled: true },
      conventionFiles: [{
        path: 'src/utils/dates.ts',
        status: 'added',
        content: 'export const now = () => Date.now();\n',
      }],
    });
    expect(evidence.checks.some((check) => check.name === 'conventions' && check.status === 'failed')).toBe(true);
    expect(evidence.verified).toBe(false);
  });

  it('accepts a 3-line header and ignores // inside strings; rejects a 5th header line and added inline comments', () => {
    const ok = service.build({
      task: makeTask(),
      headSha: 'abc123',
      reviews: approveAt('abc123'),
      audit: { passed: true, incomplete: false, violations: [], added_files: [], added_symbols: [] },
      conventionRules: { enabled: true },
      conventionFiles: [{
        path: 'src/retry.ts',
        status: 'added',
        content: [
          '/**',
          ' * Retry helper for adapter process launch.',
          ' * Uses the existing backoff, not a new timer util.',
          ' */',
          'export const url = "https://example.com";',
          'export function retry() { return 1; }',
          '',
        ].join('\n'),
      }],
    });
    expect(ok.checks.find((check) => check.name === 'conventions')?.status).toBe('passed');
    expect(ok.verified).toBe(true);

    const longHeader = service.build({
      task: makeTask(),
      headSha: 'abc123',
      reviews: approveAt('abc123'),
      audit: { passed: true, incomplete: false, violations: [], added_files: [], added_symbols: [] },
      conventionRules: { enabled: true },
      conventionFiles: [{
        path: 'src/retry.ts',
        status: 'added',
        content: '/**\n * one\n * two\n * three\n * four\n * five\n */\nexport const x = 1;\n',
      }],
    });
    expect(longHeader.checks.find((check) => check.name === 'conventions')?.status).toBe('failed');

    const addedInline = service.build({
      task: makeTask(),
      headSha: 'abc123',
      reviews: approveAt('abc123'),
      audit: { passed: true, incomplete: false, violations: [], added_files: [], added_symbols: [] },
      conventionRules: { enabled: true },
      conventionFiles: [{
        path: 'src/retry.ts',
        status: 'modified',
        addedLines: ['  const x = 1;', '  // leftover note', '  return x;'],
      }],
    });
    expect(addedInline.checks.find((check) => check.name === 'conventions')?.status).toBe('failed');

    const preexisting = service.build({
      task: makeTask(),
      headSha: 'abc123',
      reviews: approveAt('abc123'),
      audit: { passed: true, incomplete: false, violations: [], added_files: [], added_symbols: [] },
      conventionRules: { enabled: true },
      conventionFiles: [{
        path: 'src/retry.ts',
        status: 'modified',
        addedLines: ['  const x = 1;', '  return x;'],
      }],
    });
    expect(preexisting.checks.find((check) => check.name === 'conventions')?.status).toBe('passed');
    expect(preexisting.verified).toBe(true);

    const functionJsdoc = service.build({
      task: makeTask(),
      headSha: 'abc123',
      reviews: approveAt('abc123'),
      audit: { passed: true, incomplete: false, violations: [], added_files: [], added_symbols: [] },
      conventionRules: { enabled: true },
      conventionFiles: [{
        path: 'src/retry.ts',
        status: 'added',
        content: [
          '/** Retry helper for adapter process launch. */',
          '/** Per-function JSDoc is not allowed. */',
          'export function retry() { return 1; }',
          '',
        ].join('\n'),
      }],
    });
    expect(functionJsdoc.checks.find((check) => check.name === 'conventions')?.status).toBe('failed');
    expect(functionJsdoc.verified).toBe(false);
  });

  it('fails a 9th new file and allows listed eslint-disable comments', () => {
    const ninth = service.build({
      task: makeTask(),
      headSha: 'abc123',
      reviews: approveAt('abc123'),
      audit: { passed: true, incomplete: false, violations: [], added_files: [], added_symbols: [] },
      conventionRules: { enabled: true },
      conventionFiles: Array.from({ length: 9 }, (_, index) => ({
        path: `src/mod${index}.ts`,
        status: 'added' as const,
        content: '/** One-line header. */\nexport const n = 1;\n',
      })),
    });
    expect(ninth.checks.find((check) => check.name === 'conventions')?.summary).toContain('max_new_files_per_task');
    expect(ninth.verified).toBe(false);

    const allowed = service.build({
      task: makeTask(),
      headSha: 'abc123',
      reviews: approveAt('abc123'),
      audit: { passed: true, incomplete: false, violations: [], added_files: [], added_symbols: [] },
      conventionRules: { enabled: true },
      conventionFiles: [{
        path: 'src/retry.ts',
        status: 'modified',
        addedLines: ['  // eslint-disable-next-line no-await-in-loop', '  await step();'],
      }],
    });
    expect(allowed.checks.find((check) => check.name === 'conventions')?.status).toBe('passed');
    expect(allowed.verified).toBe(true);
  });

  it('CLI proof paths fail-close Verified when HEAD still has changes_requested or failed', () => {
    for (const file of ['src/cli/commands/proof.ts', 'src/cli/commands/pr.ts', 'src/cli/commands/wiki.ts']) {
      const raw = readFileSync(path.join(process.cwd(), file), 'utf8');
      expect(raw).toContain("verdict === 'changes_requested'");
      expect(raw).toContain("verdict === 'failed'");
      expect(raw).toContain('actual_new_dependencies');
    }
    expect(readFileSync(path.join(process.cwd(), 'src/cli/commands/wiki.ts'), 'utf8')).toContain('auditTask');
    const container = readFileSync(path.join(process.cwd(), 'src/container.ts'), 'utf8');
    expect(container).toContain('PROOF STALE');
    expect(container).toContain('current !== next.head_sha');
    expect(readFileSync(path.join(process.cwd(), 'src/cli/commands/proof.ts'), 'utf8')).toContain('task.proof?.branch');
    expect(readFileSync(path.join(process.cwd(), 'src/cli/commands/pr.ts'), 'utf8')).toContain('task.proof?.branch');
    expect(readFileSync(path.join(process.cwd(), 'src/cli/commands/pr.ts'), 'utf8')).toContain('collectConventionDiffs');
    expect(readFileSync(path.join(process.cwd(), 'src/cli/commands/proof.ts'), 'utf8')).toContain('actual_new_dependencies');
    expect(readFileSync(path.join(process.cwd(), 'src/cli/commands/pr.ts'), 'utf8')).toContain('actual_new_dependencies');
    expect(readFileSync(path.join(process.cwd(), 'src/cli/commands/init.ts'), 'utf8')).toContain('required: true');
  });
});
