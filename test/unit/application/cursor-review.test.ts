import { describe, it, expect } from 'vitest';
import { parseCursorReview } from '../../../src/application/cursor-review.js';

describe('parseCursorReview', () => {
  it('approves only a clean approve verdict', () => {
    const result = parseCursorReview('{"verdict":"approve","summary":"ok","blocking_findings":[]}');
    expect(result.verdict).toBe('approve');
  });

  it('fail-closes on missing JSON', () => {
    expect(parseCursorReview('looks good').verdict).toBe('failed');
  });

  it('downgrades approve when blocking findings exist', () => {
    const result = parseCursorReview('{"verdict":"approve","summary":"nope","blocking_findings":["secret"]}');
    expect(result.verdict).toBe('changes_requested');
  });
});
