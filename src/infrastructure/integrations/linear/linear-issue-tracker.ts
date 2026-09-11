/**
 * Linear issue tracker via official GraphQL HTTP API.
 * The Linear desktop app and Cursor Linear MCP cannot authenticate this CLI —
 * they are other processes. Resolve a key from LINEAR_API_KEY or
 * `~/.orchestry/linear.token` (`orch integration login`). Never store the key in task files.
 */

import { homedir } from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { readJson, readYaml, writeJson } from '../../storage/fs-utils.js';
import type { Agent } from '../../../domain/agent.js';
import type { ReviewEvidence, VerificationEvidence } from '../../../domain/evidence.js';
import { renderLinearProof } from '../../proof/renderers.js';
import type {
  ExternalIssueRef,
  IIssueTracker,
  MergeEvidence,
  PullRequestRef,
} from '../../../domain/integration.js';
import type { Task, TaskStatus } from '../../../domain/task.js';
import { OrchestryError } from '../../../domain/errors.js';

export class LinearConfigError extends OrchestryError {
  constructor(message: string, hint?: string) {
    super(message, 1, hint);
    this.name = 'LinearConfigError';
  }
}

export const LINEAR_VERIFIED_LABEL = 'verified';

const ORCH_STATE_PREFIX = 'orch state /';

const ORCH_STATE_LABEL: Record<TaskStatus | 'changes_requested' | 'verified' | 'blocked', string> = {
  todo: 'ORCH State / Planned',
  in_progress: 'ORCH State / In Progress',
  retrying: 'ORCH State / In Progress',
  review: 'ORCH State / In Review',
  done: 'ORCH State / Merged',
  failed: 'ORCH State / Failed',
  cancelled: 'ORCH State / Failed',
  changes_requested: 'ORCH State / Changes Requested',
  verified: 'ORCH State / Verified',
  blocked: 'ORCH State / Blocked',
};

export function orchLinearLabelNames(task: Pick<Task, 'labels'>): string[] {
  const labels = task.labels.map((label) => label.trim()).filter(Boolean);
  const joined = labels.join(' ').toLowerCase();
  const derived: string[] = [];
  if (/\b(bug|defect)\b/.test(joined)) derived.push('type / bug');
  if (/\b(feature|feat)\b/.test(joined)) derived.push('type / feature');
  if (/\bchore\b/.test(joined)) derived.push('type / chore');
  if (/\b(critical|high-risk)\b/.test(joined) || /(^|\s)high(\s|$)/.test(joined)) derived.push('risk / high');
  else if (/\bmedium\b/.test(joined)) derived.push('risk / medium');
  else if (/\blow\b/.test(joined)) derived.push('risk / low');
  return [...new Set(['orch', ...labels, ...derived])];
}

type LinearStatusOwner = 'orch' | 'linear-github' | 'hybrid';

const statusOwnerByTracker = new WeakMap<LinearIssueTracker, LinearStatusOwner>();
const mappingRootByTracker = new WeakMap<LinearIssueTracker, string>();

function findOrchestryRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, '.orchestry');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(process.cwd(), '.orchestry');
}

async function persistLinearMapping(
  tracker: LinearIssueTracker,
  taskId: string,
  ref: ExternalIssueRef,
): Promise<void> {
  const root = mappingRootByTracker.get(tracker);
  if (!root) return;
  try {
    const file = path.join(root, 'integrations', 'linear', 'mappings.json');
    const current = await readJson<Record<string, {
      id: string;
      identifier?: string;
      url?: string;
      synced_at?: string;
    }>>(file) ?? {};
    current[taskId] = {
      id: ref.id,
      identifier: ref.identifier,
      url: ref.url,
      synced_at: ref.synced_at,
    };
    await writeJson(file, current);
  } catch {
    // Fail-open: task.external.linear remains the live mapping.
  }
}

function resolveLinearStatusOwner(raw?: string): LinearStatusOwner {
  if (raw === 'orch' || raw === 'linear-github' || raw === 'hybrid') return raw;
  return 'hybrid';
}

function orchOwnsLinearWorkflowState(tracker: LinearIssueTracker): boolean {
  return statusOwnerByTracker.get(tracker) !== 'linear-github';
}

export class LinearIssueTracker implements IIssueTracker {
  constructor(
    private readonly apiKey: string,
    private readonly teamKey?: string,
    private readonly http: typeof fetch = fetch,
  ) {}

  async createForTask(task: Task): Promise<ExternalIssueRef> {
    let recovered: ExternalIssueRef | undefined;
    const mappingRoot = mappingRootByTracker.get(this);

    if (task.external?.linear?.id) {
      recovered = {
        provider: 'linear',
        id: task.external.linear.id,
        identifier: task.external.linear.identifier ?? task.external.linear.id,
        url: task.external.linear.url ?? '',
        synced_at: new Date().toISOString(),
      };
      await persistLinearMapping(this, task.id, recovered);
    } else if (mappingRoot) {
      try {
        const file = path.join(mappingRoot, 'integrations', 'linear', 'mappings.json');
        const current = await readJson<Record<string, {
          id: string;
          identifier?: string;
          url?: string;
          synced_at?: string;
        }>>(file) ?? {};
        const mapped = current[task.id];
        if (mapped?.id) {
          recovered = {
            provider: 'linear',
            id: mapped.id,
            identifier: mapped.identifier ?? mapped.id,
            url: mapped.url ?? '',
            synced_at: new Date().toISOString(),
          };
          await persistLinearMapping(this, task.id, recovered);
        }
      } catch {
        // continue to remote fingerprint lookup
      }
    }
    if (!recovered) {
      try {
        const fingerprint = `ORCH task: \`${task.id}\``;
        const found = await this.graphql<{
          issues?: { nodes?: Array<{ id: string; identifier: string; url: string; description?: string }> };
        }>(
          `query($filter: IssueFilter!) {
            issues(filter: $filter, first: 10) {
              nodes { id identifier url description }
            }
          }`,
          { filter: { description: { contains: fingerprint } } },
        );
        const hit = found.issues?.nodes?.find((issue) => (issue.description ?? '').includes(fingerprint));
        if (hit) {
          recovered = {
            provider: 'linear',
            id: hit.id,
            identifier: hit.identifier,
            url: hit.url,
            synced_at: new Date().toISOString(),
          };
          await persistLinearMapping(this, task.id, recovered);
        }
      } catch {
        // continue to create
      }
    }

    let goalTitle = '';
    if (task.goalId && mappingRoot) {
      try {
        const goal = await readYaml<{ title?: string }>(path.join(mappingRoot, 'goals', `${task.goalId}.yml`));
        if (typeof goal?.title === 'string' && goal.title.trim()) goalTitle = goal.title.trim();
      } catch {
        // Goal id still fingerprints the issue; title is additive.
      }
    }
    const description = [
      '## ORCH Task',
      '',
      `ORCH task: \`${task.id}\``,
      task.goalId ? `Goal: \`${task.goalId}${goalTitle ? ` / ${goalTitle}` : ''}\`` : '',
      task.plan_id ? `Plan: \`${task.plan_id}\`` : '',
      task.plan_unit_id ? `Plan unit: \`${task.plan_unit_id}\`` : '',
      task.council_ref ? `Council: \`${task.council_ref}\`` : '',
      task.assignee ? `Assignee/worker: ${task.assignee}` : '',
      `Priority: ${task.priority}`,
      task.labels.length ? `Risk/labels: ${task.labels.join(', ')}` : '',
      '',
      '### Description',
      task.description || task.title,
      '',
      '### Scope',
      ...(task.scope?.length ? task.scope.map((item) => `- ${item}`) : ['- (none)']),
      '',
      '### Acceptance criteria',
      ...(task.acceptance_criteria?.length
        ? task.acceptance_criteria.map((item) => `- [ ] ${item}`)
        : ['- [ ] (none listed)']),
      '',
      '### Verification plan',
      ...(task.review_criteria?.length
        ? task.review_criteria.map((item) => `- ${item}`)
        : ['- Tests / typecheck / lint as required by the task']),
      '',
      '### Dependencies',
      ...(task.depends_on.length ? task.depends_on.map((id) => `- ${id}`) : ['- (none)']),
      '',
      'Do not create a second issue for this ORCH id.',
    ].filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n');

    if (recovered) {
      try {
        await this.graphql(
          `mutation($id: String!, $input: IssueUpdateInput!) {
            issueUpdate(id: $id, input: $input) { success }
          }`,
          { id: recovered.id, input: { title: task.title, description } },
        );
      } catch {
        // Fail-open: the recovered issue remains the unique Linear id.
      }
      return recovered;
    }

    const teamId = await this.resolveTeamId();
    const data = await this.graphql<{
      issueCreate: { success: boolean; issue?: { id: string; identifier: string; url: string } };
    }>(
      `mutation($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { id identifier url } }
      }`,
      {
        input: {
          teamId,
          title: task.title,
          description,
          labelIds: await this.resolveLabelIds(teamId, [
            ...orchLinearLabelNames(task),
            ORCH_STATE_LABEL.todo,
          ]),
        },
      },
    );

    const issue = data.issueCreate.issue;
    if (!data.issueCreate.success || !issue) {
      throw new LinearConfigError('Linear issueCreate failed');
    }

    const created: ExternalIssueRef = {
      provider: 'linear',
      id: issue.id,
      identifier: issue.identifier,
      url: issue.url,
      synced_at: new Date().toISOString(),
    };
    await persistLinearMapping(this, task.id, created);
    return created;
  }

  /** Spec §6.4: rewrite the Dependencies section with Linear identifiers when they exist. */
  async refreshDependencyDescription(issueId: string, lines: string[]): Promise<void> {
    if (lines.length === 0) return;
    try {
      const data = await this.graphql<{ issue: { description?: string | null } }>(
        `query($id: String!) { issue(id: $id) { description } }`,
        { id: issueId },
      );
      const current = data.issue.description ?? '';
      const block = ['### Dependencies', ...lines].join('\n');
      const next = /### Dependencies\n(?:- .+\n?)*/.test(current)
        ? current.replace(/### Dependencies\n(?:- .+\n?)*/, `${block}\n`)
        : `${current.trim()}\n\n${block}\n`;
      if (next === current) return;
      await this.graphql(
        `mutation($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success }
        }`,
        { id: issueId, input: { description: next } },
      );
    } catch {
      // Fail-open: blockedBy relations and original ORCH ids remain.
    }
  }

  /** Spec §6.4: when dependency Linear issues exist, relate them as blockedBy. */
  async linkBlockedBy(issueId: string, blockerIssueIds: string[]): Promise<void> {
    const unique = [...new Set(blockerIssueIds.filter((id) => id && id !== issueId))];
    for (const relatedIssueId of unique) {
      try {
        await this.graphql(
          `mutation($input: IssueRelationCreateInput!) {
            issueRelationCreate(input: $input) { success }
          }`,
          { input: { issueId, relatedIssueId, type: 'blockedBy' } },
        );
      } catch {
        // Fail-open: the issue description already lists ORCH depends_on.
      }
    }
  }

  async onTaskAssigned(task: Task, agent: Agent): Promise<void> {
    const issueId = task.external?.linear?.id;
    if (!issueId) return;
    const marker = `<!-- orch-dispatch:${task.id} -->`;
    const body = [
      marker,
      '### Task dispatched',
      '',
      `ORCH task: \`${task.id}\``,
      `Agent: ${agent.name} (\`${agent.id}\`, ${agent.adapter})`,
      task.workspace ? `Workspace: \`${task.workspace}\`` : '',
      task.proof?.branch ? `Branch: \`${task.proof.branch}\`` : '',
      '',
      'Verification is pending.',
    ].filter(Boolean).join('\n');
    let existingId: string | undefined;
    try {
      const data = await this.graphql<{ issue: { comments: { nodes: Array<{ id: string; body: string }> } } }>(
        `query($id: String!) { issue(id: $id) { comments { nodes { id body } } } }`,
        { id: issueId },
      );
      existingId = data.issue.comments.nodes.find((node) => node.body.includes(marker))?.id;
    } catch {
      existingId = undefined;
    }
    if (existingId) await this.updateComment(existingId, body);
    else await this.comment(issueId, body);
    try {
      const teamId = await this.resolveTeamId();
      const added = await this.resolveLabelIds(teamId, [`agent / ${agent.adapter}`]);
      if (!added?.length) return;
      const data = await this.graphql<{ issue: { labels: { nodes: Array<{ id: string }> } } }>(
        `query($id: String!) { issue(id: $id) { labels { nodes { id } } } }`,
        { id: issueId },
      );
      const current = data.issue.labels.nodes.map((node) => node.id);
      const next = [...new Set([...current, ...added])];
      if (next.length === current.length) return;
      await this.graphql(
        `mutation($id: String!, $labelIds: [String!]!) {
          issueUpdate(id: $id, input: { labelIds: $labelIds }) { success }
        }`,
        { id: issueId, labelIds: next },
      );
    } catch {
      // Fail-open: assignment comment is already posted.
    }
  }

  async onTaskStatusChanged(task: Task, _from: TaskStatus, to: TaskStatus): Promise<void> {
    const issueId = task.external?.linear?.id;
    if (!issueId) return;
    const blocked = /(Council |CODE ADMISSION FAILED|ADMISSION BLOCKED)/i.test(task.feedback ?? '');
    if (blocked) {
      const marker = `<!-- orch-blocked:${task.id} -->`;
      const body = [
        marker,
        '### Task blocked',
        '',
        `ORCH task \`${task.id}\` cannot proceed.`,
        task.feedback ? `Reason: ${task.feedback}` : '',
      ].filter(Boolean).join('\n');
      let existingId: string | undefined;
      try {
        const data = await this.graphql<{ issue: { comments: { nodes: Array<{ id: string; body: string }> } } }>(
          `query($id: String!) { issue(id: $id) { comments { nodes { id body } } } }`,
          { id: issueId },
        );
        existingId = data.issue.comments.nodes.find((node) => node.body.includes(marker))?.id;
      } catch {
        existingId = undefined;
      }
      if (existingId) await this.updateComment(existingId, body);
      else await this.comment(issueId, body);
      await this.applyOrchStateLabel(issueId, ORCH_STATE_LABEL.blocked);
      if (orchOwnsLinearWorkflowState(this)) {
        try {
          const teamId = await this.resolveTeamId();
          const states = await this.graphql<{ team: { states: { nodes: Array<{ id: string; name: string }> } } }>(
            `query($id: String!) { team(id: $id) { states { nodes { id name } } } }`,
            { id: teamId },
          );
          const stateId = states.team.states.nodes.find((state) => /\bblocked\b/.test(state.name.toLowerCase()))?.id;
          if (stateId) {
            await this.graphql(
              `mutation($id: String!, $stateId: String!) {
                issueUpdate(id: $id, input: { stateId: $stateId }) { success }
              }`,
              { id: issueId, stateId },
            );
          }
        } catch {
          // Fail-open: the Blocked label and comment are already posted.
        }
      }
      await this.createForTask(task);
      return;
    }
    if (to === 'failed' || to === 'cancelled') {
      const marker = `<!-- orch-terminal:${task.id} -->`;
      const body = [
        marker,
        to === 'failed' ? '### Task failed' : '### Task cancelled',
        '',
        `ORCH task \`${task.id}\` is \`${to}\`.`,
        task.feedback ? `Feedback: ${task.feedback}` : '',
        '',
        'This is a terminal ORCH state. Re-open from ORCH if the work should continue.',
      ].filter(Boolean).join('\n');
      let existingId: string | undefined;
      try {
        const data = await this.graphql<{ issue: { comments: { nodes: Array<{ id: string; body: string }> } } }>(
          `query($id: String!) { issue(id: $id) { comments { nodes { id body } } } }`,
          { id: issueId },
        );
        existingId = data.issue.comments.nodes.find((node) => node.body.includes(marker))?.id;
      } catch {
        existingId = undefined;
      }
      if (existingId) await this.updateComment(existingId, body);
      else await this.comment(issueId, body);
    }
    if (orchOwnsLinearWorkflowState(this)) {
      const stateId = await this.resolveStateId(to);
      if (stateId) {
        await this.graphql(
          `mutation($id: String!, $stateId: String!) {
            issueUpdate(id: $id, input: { stateId: $stateId }) { success }
          }`,
          { id: issueId, stateId },
        );
      }
    }
    await this.applyOrchStateLabel(issueId, ORCH_STATE_LABEL[to]);
    await this.createForTask(task);
  }

  async onPullRequestLinked(task: Task, pr: PullRequestRef): Promise<void> {
    const issueId = task.external?.linear?.id;
    if (!issueId) return;
    const marker = `<!-- orch-pr:${task.id}:${pr.number} -->`;
    const legacy = `<!-- orch-pr:${task.id} -->`;
    const body = [
      marker,
      '### Pull request opened',
      '',
      `PR: ${pr.url}`,
      pr.branch ? `Branch: \`${pr.branch}\`` : '',
      pr.head_sha ? `Head: \`${pr.head_sha.slice(0, 7)}\`` : '',
      '',
      'Review path: Cursor automated review or human approval.',
      'Verification is pending.',
    ].filter(Boolean).join('\n');
    let existingId: string | undefined;
    let alreadyLinked = false;
    try {
      const data = await this.graphql<{ issue: { comments: { nodes: Array<{ id: string; body: string }> } } }>(
        `query($id: String!) { issue(id: $id) { comments { nodes { id body } } } }`,
        { id: issueId },
      );
      const existing = data.issue.comments.nodes.find((node) => node.body.includes(marker))
        ?? data.issue.comments.nodes.find((node) => node.body.includes(legacy) && node.body.includes(pr.url));
      existingId = existing?.id;
      const shaHint = pr.head_sha ? pr.head_sha.slice(0, 7) : '';
      alreadyLinked = Boolean(
        existing
        && existing.body.includes(pr.url)
        && (!shaHint || existing.body.includes(shaHint)),
      );
    } catch {
      existingId = undefined;
    }
    if (!alreadyLinked) {
      if (existingId) await this.updateComment(existingId, body);
      else await this.comment(issueId, body);
    }
    await this.applyOrchStateLabel(issueId, ORCH_STATE_LABEL.review);
    try {
      await this.graphql(
        `mutation($issueId: String!, $url: String!) {
          attachmentLinkGitHubPR(issueId: $issueId, url: $url) { success }
        }`,
        { issueId, url: pr.url },
      );
    } catch {
      try {
        await this.graphql(
          `mutation($issueId: String!, $url: String!, $title: String!) {
            attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success }
          }`,
          { issueId, url: pr.url, title: `GitHub PR #${pr.number}` },
        );
      } catch {
        // Fail-open: the PR comment is already posted.
      }
    }
  }

  async publishEvidence(task: Task, evidence: VerificationEvidence): Promise<void> {
    const issueId = task.external?.linear?.id;
    if (!issueId) return;
    if (!evidence.head_sha) {
      throw new Error('Proof has no HEAD SHA — cannot publish Verified comment');
    }
    if ((evidence.reviews ?? []).some((review) => (
      review.commit_sha === evidence.head_sha
      && (review.verdict === 'changes_requested' || review.verdict === 'failed')
    ))) {
      evidence.verified = false;
      delete evidence.verified_at;
    }
    const marker = `<!-- orch-proof:${task.id}:${evidence.head_sha} -->`;
    const deleted = task.feedback
      ?.split('\n')
      .find((line) => /^admission: deleted symbols:/i.test(line))
      ?.replace(/^admission: deleted symbols:\s*/i, '')
      .trim();
    const extra = evidence.admission as {
      admission_requests?: string[];
      repo?: string;
      worktree?: string;
    } | undefined;
    const body = [
      marker,
      renderLinearProof(evidence),
      deleted ? `- Deleted symbols: ${deleted}` : '',
      extra?.admission_requests?.length ? `- Admission requests: ${extra.admission_requests.join(', ')}` : '',
      extra?.repo ? `- GitNexus repo: ${extra.repo}` : '',
      extra?.worktree ? `- Worktree path: ${extra.worktree}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const existingId = await this.findProofCommentId(issueId, task.id);
    if (existingId) await this.updateComment(existingId, body);
    else await this.comment(issueId, body);
    await this.applyVerifiedLabel(issueId, evidence.verified === true);
    await this.applyOrchStateLabel(
      issueId,
      evidence.verified === true ? ORCH_STATE_LABEL.verified : ORCH_STATE_LABEL.review,
    );
  }

  /** Spec §8.5: Verified only for the current SHA; a later commit returns In Review. */
  private async applyVerifiedLabel(issueId: string, verified: boolean): Promise<void> {
    try {
      const teamId = await this.resolveTeamId();
      const verifiedId = (await this.resolveLabelIds(teamId, [LINEAR_VERIFIED_LABEL]))?.[0];
      if (!verifiedId) return;
      const data = await this.graphql<{ issue: { labels: { nodes: Array<{ id: string; name: string }> } } }>(
        `query($id: String!) { issue(id: $id) { labels { nodes { id name } } } }`,
        { id: issueId },
      );
      const current = data.issue.labels.nodes.map((node) => node.id);
      const next = verified
        ? [...new Set([...current, verifiedId])]
        : current.filter((id) => id !== verifiedId);
      const same = next.length === current.length && next.every((id) => current.includes(id));
      if (!same) {
        await this.graphql(
          `mutation($id: String!, $labelIds: [String!]!) {
            issueUpdate(id: $id, input: { labelIds: $labelIds }) { success }
          }`,
          { id: issueId, labelIds: next },
        );
      }
      if (orchOwnsLinearWorkflowState(this)) {
        let stateId = await this.resolveStateId('review');
        if (verified) {
          const states = await this.graphql<{ team: { states: { nodes: Array<{ id: string; name: string }> } } }>(
            `query($id: String!) { team(id: $id) { states { nodes { id name } } } }`,
            { id: teamId },
          );
          const wanted = ['ready for merge', 'in review', 'review'];
          stateId = states.team.states.nodes.find((state) => wanted.includes(state.name.toLowerCase()))?.id
            ?? stateId;
        }
        if (stateId) {
          await this.graphql(
            `mutation($id: String!, $stateId: String!) {
              issueUpdate(id: $id, input: { stateId: $stateId }) { success }
            }`,
            { id: issueId, stateId },
          );
        }
      }
    } catch {
      // Fail-open: proof comment is already posted.
    }
  }

  async onReview(task: Task, review: ReviewEvidence): Promise<void> {
    const issueId = task.external?.linear?.id;
    if (!issueId) return;
    const sha = review.commit_sha.trim();
    const verdict = sha ? review.verdict : 'failed';
    const extra = review as ReviewEvidence & { blocking_findings?: string[]; plan_deviations?: string[] };
    const extras = [
      ...(extra.blocking_findings ?? []).map((item) => `- blocking: ${item}`),
      ...(extra.plan_deviations ?? []).map((item) => `- plan: ${item}`),
    ];
    const marker = `<!-- orch-review:${task.id}:${sha || 'missing'} -->`;
    const body = [
      marker,
      verdict === 'changes_requested' || verdict === 'failed' ? '### Review changes requested' : '### Review',
      '',
      `Reviewer: ${review.reviewer_type} (${review.reviewer})`,
      `Verdict: ${verdict}`,
      `Head: \`${sha ? sha.slice(0, 7) : 'missing'}\``,
      !sha ? 'Summary: Review missing commit SHA — fail closed.' : (review.summary ? `Summary: ${review.summary}` : ''),
      ...extras,
    ].filter(Boolean).join('\n');
    let existingId: string | undefined;
    try {
      const data = await this.graphql<{ issue: { comments: { nodes: Array<{ id: string; body: string }> } } }>(
        `query($id: String!) { issue(id: $id) { comments { nodes { id body } } } }`,
        { id: issueId },
      );
      existingId = data.issue.comments.nodes.find((node) => node.body.includes(marker))?.id;
    } catch {
      existingId = undefined;
    }
    if (existingId) await this.updateComment(existingId, body);
    else await this.comment(issueId, body);
    if (verdict === 'changes_requested' || verdict === 'failed') {
      if (orchOwnsLinearWorkflowState(this)) {
        const stateId = await this.resolveStateId('in_progress');
        if (stateId) {
          await this.graphql(
            `mutation($id: String!, $stateId: String!) {
              issueUpdate(id: $id, input: { stateId: $stateId }) { success }
            }`,
            { id: issueId, stateId },
          );
        }
      }
      await this.applyOrchStateLabel(issueId, ORCH_STATE_LABEL.changes_requested);
    }
    try {
      const prUrl = task.external?.github?.pr_url;
      if (!prUrl) return;
      const data = await this.graphql<{
        issue: { attachments: { nodes: Array<{ id: string; url?: string }> } };
      }>(
        `query($id: String!) { issue(id: $id) { attachments { nodes { id url } } } }`,
        { id: issueId },
      );
      const attachment = data.issue.attachments.nodes.find((node) => (
        node.url === prUrl || Boolean(node.url?.includes('/pull/'))
      ));
      if (!attachment) return;
      await this.graphql(
        `mutation($id: String!, $title: String!) {
          attachmentUpdate(id: $id, input: { title: $title }) { success }
        }`,
        {
          id: attachment.id,
          title: `GitHub PR — ${verdict} @ ${sha ? sha.slice(0, 7) : 'missing'}`,
        },
      );
    } catch {
      // Fail-open: the review comment is already posted.
    }
  }

  async onMerged(task: Task, merge: MergeEvidence): Promise<void> {
    const issueId = task.external?.linear?.id;
    if (!issueId) return;
    const marker = `<!-- orch-merge:${task.id} -->`;
    const body = [
      marker,
      '### Merged',
      '',
      `ORCH task: \`${task.id}\``,
      `Head: \`${merge.sha.slice(0, 7)}\``,
      merge.url ? `PR: ${merge.url}` : (task.external?.github?.pr_url ? `PR: ${task.external.github.pr_url}` : ''),
      '',
      'ORCH marked this task done. Linear state follows.',
    ].filter(Boolean).join('\n');
    let existingId: string | undefined;
    try {
      const data = await this.graphql<{ issue: { comments: { nodes: Array<{ id: string; body: string }> } } }>(
        `query($id: String!) { issue(id: $id) { comments { nodes { id body } } } }`,
        { id: issueId },
      );
      existingId = data.issue.comments.nodes.find((node) => node.body.includes(marker))?.id;
    } catch {
      existingId = undefined;
    }
    if (existingId) await this.updateComment(existingId, body);
    else await this.comment(issueId, body);
    if (orchOwnsLinearWorkflowState(this)) {
      const stateId = await this.resolveStateId('done');
      if (stateId) {
        await this.graphql(
          `mutation($id: String!, $stateId: String!) {
            issueUpdate(id: $id, input: { stateId: $stateId }) { success }
          }`,
          { id: issueId, stateId },
        );
      }
    }
    await this.applyOrchStateLabel(issueId, ORCH_STATE_LABEL.done);
    try {
      const prUrl = merge.url || task.external?.github?.pr_url;
      if (!prUrl) return;
      const data = await this.graphql<{
        issue: { attachments: { nodes: Array<{ id: string; url?: string }> } };
      }>(
        `query($id: String!) { issue(id: $id) { attachments { nodes { id url } } } }`,
        { id: issueId },
      );
      const attachment = data.issue.attachments.nodes.find((node) => (
        node.url === prUrl || Boolean(node.url?.includes('/pull/'))
      ));
      if (!attachment) return;
      await this.graphql(
        `mutation($id: String!, $title: String!) {
          attachmentUpdate(id: $id, input: { title: $title }) { success }
        }`,
        {
          id: attachment.id,
          title: `GitHub PR — merged @ ${merge.sha.slice(0, 7)}`,
        },
      );
    } catch {
      // Fail-open: the merge comment is already posted.
    }
  }

  private async applyOrchStateLabel(issueId: string, wanted: string): Promise<void> {
    try {
      const teamId = await this.resolveTeamId();
      const wantedId = (await this.resolveLabelIds(teamId, [wanted]))?.[0];
      if (!wantedId) return;
      const data = await this.graphql<{ issue: { labels: { nodes: Array<{ id: string; name: string }> } } }>(
        `query($id: String!) { issue(id: $id) { labels { nodes { id name } } } }`,
        { id: issueId },
      );
      const kept = data.issue.labels.nodes
        .filter((label) => !label.name.toLowerCase().startsWith(ORCH_STATE_PREFIX))
        .map((label) => label.id);
      const next = [...new Set([...kept, wantedId])];
      const current = data.issue.labels.nodes.map((label) => label.id);
      const same = next.length === current.length && next.every((id) => current.includes(id));
      if (same) return;
      await this.graphql(
        `mutation($id: String!, $labelIds: [String!]!) {
          issueUpdate(id: $id, input: { labelIds: $labelIds }) { success }
        }`,
        { id: issueId, labelIds: next },
      );
    } catch {
      // Fail-open: Linear status remains the primary lifecycle state.
    }
  }

  private async resolveLabelIds(teamId: string, names: string[]): Promise<string[] | undefined> {
    const wanted = new Map<string, string>();
    for (const name of names) {
      const trimmed = name.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (!wanted.has(key)) wanted.set(key, trimmed);
    }
    if (wanted.size === 0) return undefined;
    try {
      const data = await this.graphql<{ team: { labels: { nodes: Array<{ id: string; name: string }> } } }>(
        `query($id: String!) { team(id: $id) { labels { nodes { id name } } } }`,
        { id: teamId },
      );
      const byName = new Map(data.team.labels.nodes.map((label) => [label.name.toLowerCase(), label.id]));
      const ids: string[] = [];
      for (const [key, display] of wanted) {
        const existing = byName.get(key);
        if (existing) {
          ids.push(existing);
          continue;
        }
        const created = await this.createLabel(teamId, display);
        if (created) {
          byName.set(key, created);
          ids.push(created);
        }
      }
      return ids.length > 0 ? ids : undefined;
    } catch {
      return undefined;
    }
  }

  private async createLabel(teamId: string, name: string): Promise<string | undefined> {
    try {
      const data = await this.graphql<{
        issueLabelCreate: { success: boolean; issueLabel?: { id: string } };
      }>(
        `mutation($input: IssueLabelCreateInput!) {
          issueLabelCreate(input: $input) { success issueLabel { id } }
        }`,
        { input: { teamId, name } },
      );
      if (!data.issueLabelCreate.success || !data.issueLabelCreate.issueLabel) return undefined;
      return data.issueLabelCreate.issueLabel.id;
    } catch {
      return undefined;
    }
  }

  private async resolveTeamId(): Promise<string> {
    const data = await this.graphql<{ teams: { nodes: Array<{ id: string; key: string }> } }>(
      `query { teams { nodes { id key } } }`,
    );
    const teams = data.teams.nodes;
    if (this.teamKey) {
      const match = teams.find((team) => team.key.toLowerCase() === this.teamKey?.toLowerCase());
      if (!match) throw new LinearConfigError(`Linear team not found: ${this.teamKey}`);
      return match.id;
    }
    const first = teams[0];
    if (!first) throw new LinearConfigError('No Linear teams available');
    return first.id;
  }

  private async resolveStateId(status: TaskStatus): Promise<string | undefined> {
    try {
      const teamId = await this.resolveTeamId();
      const data = await this.graphql<{ team: { states: { nodes: Array<{ id: string; name: string; type: string }> } } }>(
        `query($id: String!) { team(id: $id) { states { nodes { id name type } } } }`,
        { id: teamId },
      );
      const nodes = data.team.states.nodes;
      const wanted = LINEAR_STATE_FOR_TASK[status];
      const match = nodes.find((state) => wanted.includes(state.name.toLowerCase()))
        ?? nodes.find((state) => wanted.includes(state.type.toLowerCase()));
      return match?.id;
    } catch {
      return undefined;
    }
  }

  private async findProofCommentId(issueId: string, taskId: string): Promise<string | undefined> {
    try {
      const prefix = `<!-- orch-proof:${taskId}:`;
      const data = await this.graphql<{ issue: { comments: { nodes: Array<{ id: string; body: string }> } } }>(
        `query($id: String!) { issue(id: $id) { comments { nodes { id body } } } }`,
        { id: issueId },
      );
      return data.issue.comments.nodes.find((node) => node.body.includes(prefix))?.id;
    } catch {
      return undefined;
    }
  }

  private async updateComment(commentId: string, body: string): Promise<void> {
    await this.graphql(
      `mutation($id: String!, $body: String!) {
        commentUpdate(id: $id, input: { body: $body }) { success }
      }`,
      { id: commentId, body },
    );
  }

  private async comment(issueId: string, body: string): Promise<void> {
    await this.graphql(
      `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
      { input: { issueId, body } },
    );
  }

  private async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    return linearGraphql<T>(this.apiKey, query, variables, this.http);
  }
}

export const LINEAR_STATE_FOR_TASK: Record<TaskStatus, string[]> = {
  todo: ['todo', 'backlog', 'unstarted'],
  in_progress: ['in progress', 'started'],
  retrying: ['in progress', 'started'],
  review: ['in review', 'review', 'started'],
  done: ['done', 'completed', 'merged'],
  failed: ['canceled', 'cancelled'],
  cancelled: ['canceled', 'cancelled'],
};

export function linearTokenPath(): string {
  const override = process.env['ORCH_LINEAR_TOKEN_PATH']?.trim();
  return override ? path.resolve(override) : path.join(homedir(), '.orchestry', 'linear.token');
}

export function readStoredLinearApiKey(): string {
  try {
    const first = readFileSync(linearTokenPath(), 'utf8').split(/\r?\n/)[0] ?? '';
    return first.trim();
  } catch {
    return '';
  }
}

export function writeStoredLinearApiKey(apiKey: string): void {
  const filePath = linearTokenPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${apiKey.trim()}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function clearStoredLinearApiKey(): void {
  try {
    rmSync(linearTokenPath());
  } catch {
    /* already gone */
  }
}

export function resolveLinearApiKey(envName = 'LINEAR_API_KEY'): string {
  return (process.env[envName] ?? '').trim() || readStoredLinearApiKey();
}

export async function probeLinearApiKey(apiKey: string): Promise<{ name: string; teams: string[] }> {
  const data = await linearGraphql<{
    viewer: { name?: string };
    teams: { nodes: Array<{ key: string }> };
  }>(apiKey, '{ viewer { name } teams { nodes { key } } }');
  return {
    name: data.viewer.name ?? 'Linear user',
    teams: data.teams.nodes.map((team) => team.key),
  };
}

async function linearGraphql<T>(
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>,
  http: typeof fetch = fetch,
): Promise<T> {
  const response = await http('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json() as { data?: T; errors?: Array<{ message: string }> };
  if (!response.ok || payload.errors?.length) {
    throw new LinearConfigError(
      payload.errors?.map((item) => item.message).join('; ') || `Linear HTTP ${response.status}`,
      'Run `orch integration login` or set LINEAR_API_KEY. Check workflow.linear.team_key',
    );
  }
  if (!payload.data) throw new LinearConfigError('Empty Linear response');
  return payload.data;
}

export function createLinearTracker(
  workflow: {
    linear?: {
      enabled?: boolean;
      team_key?: string;
      api_key_env?: string;
      status_owner?: LinearStatusOwner;
    };
  } | null,
  http: typeof fetch = fetch,
  orchRoot?: string,
): LinearIssueTracker | null {
  if (!workflow?.linear?.enabled) return null;
  const envName = workflow.linear.api_key_env ?? 'LINEAR_API_KEY';
  const apiKey = resolveLinearApiKey(envName);
  if (!apiKey) return null;
  const timed = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const incoming = init?.signal;
      const onAbort = (): void => controller.abort();
      incoming?.addEventListener('abort', onAbort);
      try {
        const response = await http(input, { ...init, signal: controller.signal });
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          await new Promise((resolve) => { setTimeout(resolve, 200 * (2 ** attempt)); });
          continue;
        }
        return response;
      } catch (err) {
        lastError = err;
        if (incoming?.aborted || attempt >= 2) break;
        await new Promise((resolve) => { setTimeout(resolve, 200 * (2 ** attempt)); });
      } finally {
        clearTimeout(timer);
        incoming?.removeEventListener('abort', onAbort);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Linear request failed after retries');
  }) as typeof fetch;
  const tracker = new LinearIssueTracker(apiKey, workflow.linear.team_key, timed);
  const rawTeam = (tracker as unknown as { resolveTeamId: () => Promise<string> }).resolveTeamId.bind(tracker);
  let cachedTeamId: string | undefined;
  (tracker as unknown as { resolveTeamId: typeof rawTeam }).resolveTeamId = async () => {
    if (cachedTeamId) return cachedTeamId;
    cachedTeamId = await rawTeam();
    return cachedTeamId;
  };
  const rawResolve = (tracker as unknown as {
    resolveLabelIds: (teamId: string, names: string[]) => Promise<string[] | undefined>;
  }).resolveLabelIds.bind(tracker);
  const labelCache = new Map<string, string[]>();
  (tracker as unknown as { resolveLabelIds: typeof rawResolve }).resolveLabelIds = async (teamId, names) => {
    const key = `${teamId}:${[...names].map((name) => name.trim().toLowerCase()).filter(Boolean).sort().join('|')}`;
    const hit = labelCache.get(key);
    if (hit) return hit;
    const ids = await rawResolve(teamId, names);
    if (ids) labelCache.set(key, ids);
    return ids;
  };
  statusOwnerByTracker.set(tracker, resolveLinearStatusOwner(workflow.linear.status_owner));
  mappingRootByTracker.set(tracker, orchRoot ?? findOrchestryRoot());
  return tracker;
}
