import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  LINEAR_STATE_FOR_TASK,
  clearStoredLinearApiKey,
  createLinearTracker,
  readStoredLinearApiKey,
  resolveLinearApiKey,
  writeStoredLinearApiKey,
} from '../../../src/infrastructure/integrations/linear/linear-issue-tracker.js';

describe('Linear status mapping', () => {
  it('maps ORCH statuses onto Linear state names', () => {
    expect(LINEAR_STATE_FOR_TASK.todo).toContain('todo');
    expect(LINEAR_STATE_FOR_TASK.in_progress).toContain('in progress');
    expect(LINEAR_STATE_FOR_TASK.review).toContain('in review');
    expect(LINEAR_STATE_FOR_TASK.done).toContain('done');
    expect(LINEAR_STATE_FOR_TASK.failed).toContain('canceled');
  });
});

describe('Linear credential store', () => {
  const previousTokenPath = process.env['ORCH_LINEAR_TOKEN_PATH'];
  const previousApiKey = process.env['LINEAR_API_KEY'];
  let dir: string;

  afterEach(() => {
    if (previousTokenPath === undefined) delete process.env['ORCH_LINEAR_TOKEN_PATH'];
    else process.env['ORCH_LINEAR_TOKEN_PATH'] = previousTokenPath;
    if (previousApiKey === undefined) delete process.env['LINEAR_API_KEY'];
    else process.env['LINEAR_API_KEY'] = previousApiKey;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('reads a stored key when LINEAR_API_KEY is unset', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'orch-linear-'));
    process.env['ORCH_LINEAR_TOKEN_PATH'] = path.join(dir, 'linear.token');
    delete process.env['LINEAR_API_KEY'];
    writeStoredLinearApiKey('lin_api_stored');
    expect(readStoredLinearApiKey()).toBe('lin_api_stored');
    expect(resolveLinearApiKey()).toBe('lin_api_stored');
    expect(createLinearTracker({ linear: { enabled: true } })).not.toBeNull();
  });

  it('lets LINEAR_API_KEY win over the stored file', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'orch-linear-'));
    process.env['ORCH_LINEAR_TOKEN_PATH'] = path.join(dir, 'linear.token');
    writeStoredLinearApiKey('lin_api_stored');
    process.env['LINEAR_API_KEY'] = 'lin_api_env';
    expect(resolveLinearApiKey()).toBe('lin_api_env');
  });

  it('returns no tracker when Linear is enabled but no credential exists', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'orch-linear-'));
    process.env['ORCH_LINEAR_TOKEN_PATH'] = path.join(dir, 'missing.token');
    delete process.env['LINEAR_API_KEY'];
    expect(createLinearTracker({ linear: { enabled: true } })).toBeNull();
    clearStoredLinearApiKey();
    expect(readStoredLinearApiKey()).toBe('');
  });
});
