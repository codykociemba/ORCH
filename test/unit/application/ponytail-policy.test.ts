import { describe, it, expect } from 'vitest';
import { resolvePonytailMode, renderPonytailPrompt } from '../../../src/application/ponytail-policy.js';
import { DEFAULT_WORKFLOW_CONFIG } from '../../../src/domain/workflow-config.js';

const workflow = DEFAULT_WORKFLOW_CONFIG;

describe('DEFAULT_WORKFLOW_CONFIG team schema', () => {
  it('includes Linear, GitHub, review, and orchestration keys for new installs', () => {
    expect(workflow.orchestration?.lead_adapter).toBe('claude');
    expect(workflow.linear?.api_key_env).toBe('LINEAR_API_KEY');
    expect(workflow.github?.publish_proof).toBe(true);
    expect(workflow.review?.accepted_reviewers).toEqual(['human', 'cursor']);
    expect(workflow.council?.required_task_count).toBe(5);
  });
});

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

  it('prompt says acceptance criteria override Ponytail', () => {
    const text = renderPonytailPrompt({ mode: 'lite', reason: 'normal implementation' });
    expect(text).toContain('acceptance criteria');
    expect(text).toContain('Modification Contract');
  });
});
