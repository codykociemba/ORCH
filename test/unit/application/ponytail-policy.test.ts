import { describe, it, expect } from 'vitest';
import { resolvePonytailMode } from '../../../src/application/ponytail-policy.js';
import { DEFAULT_WORKFLOW_CONFIG } from '../../../src/domain/workflow-config.js';

const workflow = DEFAULT_WORKFLOW_CONFIG;

describe('resolvePonytailMode', () => {
  it('planning is off', () => {
    expect(resolvePonytailMode('planning', { labels: [], scope: [], priority: 3 }, workflow).mode).toBe('off');
  });

  it('review is off', () => {
    expect(resolvePonytailMode('review', { labels: [], scope: [], priority: 3 }, workflow).mode).toBe('off');
  });

  it('normal implementation is lite', () => {
    expect(resolvePonytailMode('implementation', { labels: [], scope: [], priority: 3 }, workflow).mode).toBe('lite');
  });

  it('low-risk bounded is full', () => {
    expect(resolvePonytailMode('implementation', { labels: [], scope: ['src/auth/**'], priority: 3 }, workflow).mode).toBe('full');
  });

  it('high-risk is lite', () => {
    expect(resolvePonytailMode('implementation', { labels: ['high-risk'], scope: ['src/auth/**'], priority: 1 }, workflow).mode).toBe('lite');
  });
});
