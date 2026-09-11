import { describe, it, expect } from 'vitest';
import { ProofService } from '../../../src/application/proof-service.js';
import { makeTask } from './helpers.js';

describe('ProofService', () => {
  const service = new ProofService();

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
      audit: { passed: true, incomplete: false, violations: [], added_files: [], added_symbols: [] },
    });
    expect(withSha.verified).toBe(true);
  });

  it('a new HEAD SHA invalidates a prior Verified stamp', () => {
    const evidence = service.build({
      task: makeTask({ proof: { files_changed: [], head_sha: 'oldsha' } }),
      headSha: 'newsha',
      audit: { passed: true, incomplete: false, violations: [], added_files: [], added_symbols: [] },
    });
    expect(evidence.verified).toBe(false);
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
    expect(github).toContain('preview only');
    expect(service.renderLinear(evidence)).toContain('Wiki: bootstrap_required');
  });
});
