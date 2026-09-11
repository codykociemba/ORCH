/**
 * Linear issue tracker via official GraphQL HTTP API.
 * Secrets stay in LINEAR_API_KEY / workflow.linear.api_key_env — never task files.
 */

import type { Agent } from '../../../domain/agent.js';
import type { ReviewEvidence, VerificationEvidence } from '../../../domain/evidence.js';
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

export class LinearIssueTracker implements IIssueTracker {
  constructor(
    private readonly apiKey: string,
    private readonly teamKey?: string,
  ) {}

  async createForTask(task: Task): Promise<ExternalIssueRef> {
    if (task.external?.linear?.id) {
      return {
        provider: 'linear',
        id: task.external.linear.id,
        identifier: task.external.linear.identifier ?? task.external.linear.id,
        url: task.external.linear.url ?? '',
        synced_at: new Date().toISOString(),
      };
    }

    const teamId = await this.resolveTeamId();
    const description = [
      `ORCH task: ${task.id}`,
      task.plan_id ? `Plan: ${task.plan_id}` : '',
      task.plan_unit_id ? `Plan unit: ${task.plan_unit_id}` : '',
      '',
      task.description,
      '',
      task.scope?.length ? `Scope: ${task.scope.join(', ')}` : '',
      `Labels: orch${task.labels.length ? `, ${task.labels.join(', ')}` : ''}`,
      `Do not create a second issue for this ORCH id.`,
    ].filter(Boolean).join('\n');

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
          labelIds: await this.resolveLabelIds(teamId, ['orch', ...task.labels]),
        },
      },
    );

    const issue = data.issueCreate.issue;
    if (!data.issueCreate.success || !issue) {
      throw new LinearConfigError('Linear issueCreate failed');
    }

    return {
      provider: 'linear',
      id: issue.id,
      identifier: issue.identifier,
      url: issue.url,
      synced_at: new Date().toISOString(),
    };
  }

  async onTaskAssigned(task: Task, agent: Agent): Promise<void> {
    const issueId = task.external?.linear?.id;
    if (!issueId) return;
    await this.comment(issueId, `Assigned to ORCH agent \`${agent.name}\` (${agent.id}).`);
  }

  async onTaskStatusChanged(task: Task, _from: TaskStatus, to: TaskStatus): Promise<void> {
    const issueId = task.external?.linear?.id;
    if (!issueId) return;
    await this.comment(issueId, `ORCH status → \`${to}\`.`);
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

  async onPullRequestLinked(task: Task, pr: PullRequestRef): Promise<void> {
    const issueId = task.external?.linear?.id;
    if (!issueId) return;
    await this.comment(issueId, `PR linked: ${pr.url}`);
  }

  async publishEvidence(task: Task, evidence: VerificationEvidence): Promise<void> {
    const issueId = task.external?.linear?.id;
    if (!issueId) return;
    const admission = evidence.admission
      ? `Admission: ${evidence.admission.passed ? 'PASS' : 'FAIL'}${evidence.admission.violations.length ? `\n${evidence.admission.violations.join('\n')}` : ''}`
      : '';
    const marker = evidence.head_sha ? `<!-- orch-proof:${evidence.head_sha} -->` : '';
    if (marker && await this.hasCommentMarker(issueId, marker)) return;
    await this.comment(
      issueId,
      [
        marker,
        '## ORCH verification proof',
        `Verified: ${evidence.verified ? 'yes' : 'no'}`,
        evidence.head_sha ? `SHA: \`${evidence.head_sha}\`` : '',
        admission,
      ].filter(Boolean).join('\n'),
    );
  }

  async onReview(task: Task, review: ReviewEvidence): Promise<void> {
    const issueId = task.external?.linear?.id;
    if (!issueId) return;
    await this.comment(issueId, `Review (${review.reviewer_type}): ${review.verdict} — ${review.summary}`);
  }

  async onMerged(task: Task, merge: MergeEvidence): Promise<void> {
    const issueId = task.external?.linear?.id;
    if (!issueId) return;
    await this.comment(issueId, `Merged at \`${merge.sha}\`.`);
  }

  private async resolveLabelIds(teamId: string, names: string[]): Promise<string[] | undefined> {
    const wanted = [...new Set(names.map((name) => name.trim().toLowerCase()).filter(Boolean))];
    if (wanted.length === 0) return undefined;
    try {
      const data = await this.graphql<{ team: { labels: { nodes: Array<{ id: string; name: string }> } } }>(
        `query($id: String!) { team(id: $id) { labels { nodes { id name } } } }`,
        { id: teamId },
      );
      const ids = data.team.labels.nodes
        .filter((label) => wanted.includes(label.name.toLowerCase()))
        .map((label) => label.id);
      return ids.length > 0 ? ids : undefined;
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

  private async hasCommentMarker(issueId: string, marker: string): Promise<boolean> {
    try {
      const data = await this.graphql<{ issue: { comments: { nodes: Array<{ body: string }> } } }>(
        `query($id: String!) { issue(id: $id) { comments { nodes { body } } } }`,
        { id: issueId },
      );
      return data.issue.comments.nodes.some((node) => node.body.includes(marker));
    } catch {
      return false;
    }
  }

  private async comment(issueId: string, body: string): Promise<void> {
    await this.graphql(
      `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
      { input: { issueId, body } },
    );
  }

  private async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const response = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: this.apiKey,
      },
      body: JSON.stringify({ query, variables }),
    });
    const payload = await response.json() as { data?: T; errors?: Array<{ message: string }> };
    if (!response.ok || payload.errors?.length) {
      throw new LinearConfigError(
        payload.errors?.map((item) => item.message).join('; ') || `Linear HTTP ${response.status}`,
        'Check LINEAR_API_KEY and workflow.linear.team_key',
      );
    }
    if (!payload.data) throw new LinearConfigError('Empty Linear response');
    return payload.data;
  }
}

export const LINEAR_STATE_FOR_TASK: Record<TaskStatus, string[]> = {
  todo: ['todo', 'backlog', 'unstarted'],
  in_progress: ['in progress', 'started'],
  retrying: ['in progress', 'started'],
  review: ['in review', 'review', 'started'],
  done: ['done', 'completed'],
  failed: ['canceled', 'cancelled'],
  cancelled: ['canceled', 'cancelled'],
};

export function createLinearTracker(workflow: {
  linear?: { enabled?: boolean; team_key?: string; api_key_env?: string };
} | null): LinearIssueTracker | null {
  if (!workflow?.linear?.enabled) return null;
  const envName = workflow.linear.api_key_env ?? 'LINEAR_API_KEY';
  const apiKey = process.env[envName];
  if (!apiKey) return null;
  return new LinearIssueTracker(apiKey, workflow.linear.team_key);
}
