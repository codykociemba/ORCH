#!/usr/bin/env node
/**
 * Deterministic Cursor review follow-up (spec Phase F).
 * Parses agent output, posts a GitHub review, never approves on malformed JSON.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const VERDICT_RE = /\{[\s\S]*"verdict"\s*:\s*"(approve|changes_requested)"[\s\S]*\}/;

function parseCursorReview(text, commitSha) {
  const match = text.match(VERDICT_RE);
  if (!match?.[0]) {
    return {
      verdict: 'failed',
      summary: 'Cursor reviewer returned no parseable JSON — fail closed, do not approve.',
      blocking_findings: [],
      commit_sha: commitSha,
    };
  }
  try {
    const parsed = JSON.parse(match[0]);
    if (parsed.verdict !== 'approve' && parsed.verdict !== 'changes_requested') {
      return {
        verdict: 'failed',
        summary: 'Cursor reviewer verdict was not approve|changes_requested — fail closed.',
        blocking_findings: [],
        commit_sha: commitSha,
      };
    }
    const blocking = Array.isArray(parsed.blocking_findings) ? parsed.blocking_findings : [];
    if (parsed.verdict === 'approve' && blocking.length > 0) {
      return { ...parsed, verdict: 'changes_requested', commit_sha: commitSha };
    }
    return { ...parsed, commit_sha: commitSha };
  } catch {
    return {
      verdict: 'failed',
      summary: 'Cursor reviewer JSON was malformed — fail closed.',
      blocking_findings: [],
      commit_sha: commitSha,
    };
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || `${cmd} exited ${code}`));
    });
  });
}

const inputPath = process.argv[2];
const sha = process.env.HEAD_SHA ?? '';
const pr = process.env.PR_NUMBER ?? '';
if (!inputPath || !pr) {
  console.error('usage: node scripts/cursor-pr-review.mjs <agent-output>  (needs PR_NUMBER)');
  process.exit(1);
}

const text = await readFile(inputPath, 'utf8').catch(() => '');
const result = parseCursorReview(text, sha);
const artifact = {
  reviewer_type: 'cursor',
  reviewer: 'cursor-cli',
  model: process.env.CURSOR_REVIEW_MODEL ?? 'grok-4.6',
  commit_sha: sha,
  verdict: result.verdict === 'approve' ? 'approve' : result.verdict === 'changes_requested' ? 'changes_requested' : 'failed',
  summary: result.summary ?? 'Cursor review',
  timestamp: new Date().toISOString(),
};
await writeFile('cursor-review.json', `${JSON.stringify(artifact, null, 2)}\n`);

const event = result.verdict === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES';
const body = [
  `<!-- orch-review:${sha} -->`,
  `## ORCH Cursor review`,
  `Verdict: **${artifact.verdict}**`,
  sha ? `HEAD: \`${sha}\`` : '',
  '',
  artifact.summary,
  '',
  ...(result.blocking_findings ?? []).map((item) => `- blocking: ${item}`),
].filter(Boolean).join('\n');

await run('gh', ['pr', 'review', String(pr), `--event=${event === 'APPROVE' && result.verdict === 'approve' ? 'APPROVE' : 'REQUEST_CHANGES'}`, '--body', body]);

if (result.verdict !== 'approve') process.exit(1);
