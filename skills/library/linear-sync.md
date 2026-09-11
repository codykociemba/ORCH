---
name: linear-sync
version: 1.0.0
description: |
  Linear mirroring is deterministic application code. Never create a duplicate
  issue because an API response was lost.
---

# Linear sync

- Use `task.external.linear` (`id`, `identifier`, `url`).
- Issue description `Goal:` is `` `goal-id / title` `` when `.orchestry/goals/<id>.yml` has a title; otherwise just the goal id.
- Idempotency fingerprint is the ORCH task id. Look up `.orchestry/integrations/linear/mappings.json` and Linear issues whose description contains `ORCH task: \`tsk_…\`` before `issueCreate`. A lost create response must recover the existing issue, not open a second one.
- Durable mapping also lands in `.orchestry/integrations/linear/mappings.json` (gitignored). GitHub PR links land in `.orchestry/integrations/github/mappings.json`.
- CLI proof/PR publishes enqueue `linear.proof` / `linear.pr` outbox entries so `orch integration drain` can retry them. `orch run --watch`, TUI, and `orch serve` drain due entries on each orchestrator tick with the same backoff. Drain waits on exponential backoff (1s base, 30s cap) after a failed attempt; `orch integration retry` is immediate. Each Linear GraphQL HTTP call also times out at 15s and retries twice on timeout, 429, or 5xx (200ms exponential backoff) so a dropped first response does not lose the sync. Label IDs are resolved/created once per team and name set for that tracker instance. The Linear team ID is resolved once per tracker instance.
- If `linear.required_before_dispatch` is true, the watcher will not dispatch until the issue exists. After login, the next `orch` process (status, doctor, run, TUI, serve) also retries non-cancelled tasks that never got an outbox entry (created while login was missing). Watcher ticks keep doing that for a logged-in session. Pending/failed outbox entries keep the existing backoff; this backfill does not duplicate a task that already has `task.external.linear`.
- Assignment comments and `agent / <adapter>` labels use the stored agent record, not a hardcoded `unknown` adapter.
- `linear.status_owner` (default `hybrid`): ORCH sets Todo / In Progress / In Review / Ready for Merge / Done. `linear-github` leaves those states to Linear's GitHub automation and still writes ORCH comments and labels.
- Task blocked (council missing a member, admission/conventions audit fail) writes `### Task blocked` (one comment per task) and `ORCH State / Blocked`. Hybrid also sets Linear's Blocked workflow state when that name exists. `planning:council_blocked` stamps the same on every imported task for that plan.
- Linear comments are only for dispatch, PR, review, proof, merge, terminal failure, and blocker. Routine `todo → in_progress → review` updates labels/status only — no `ORCH status →` spam. Retries update the same comment in place: `<!-- orch-dispatch:<taskId> -->`, `<!-- orch-pr:<taskId>:<number> -->`, `<!-- orch-review:<taskId>:<sha> -->`, `<!-- orch-proof:<taskId>:<sha> -->`, `<!-- orch-merge:<taskId> -->`, `<!-- orch-terminal:<taskId> -->`, `<!-- orch-blocked:<taskId> -->`.
- Branch: `orch/ENG-123-slug`. PR title/body: `Fixes ENG-123` (or `Contributes to` when siblings remain). A plan with multiple Linear issues lists every identifier: `Fixes ENG-123, ENG-124` only for issues this PR completes, and `Contributes to ENG-125` for the rest so Linear does not close a sibling early. Same-branch plan units get the same PR URL, outbox fingerprint, and Linear comment. Linking a PR comments Linear once per PR (`<!-- orch-pr:<taskId>:<number> -->`) and creates a GitHub attachment (`attachmentLinkGitHubPR`, URL fallback). A later `orch pr link` of the same PR updates that comment instead of posting another. A second PR on the same task gets its own comment. The same URL and HEAD SHA do not rewrite the comment. Review and merge update that attachment title with the verdict or `merged` plus HEAD so PR state is visible on the issue.
- Retry with `orch integration retry linear <task-id>`.
- Authenticate with `orch integration login` (stores `~/.orchestry/linear.token`). Env `LINEAR_API_KEY` still wins if set. When Linear is enabled but login is missing, task create emits `integration:sync_failed` and writes the same note onto `task.feedback` so TUI/CLI can show the sync problem. Outbox drain failures emit that event too; subscribe persists the error onto `task.feedback`. `orch doctor` fails that Linear check when enabled (not only when `required_before_dispatch` is true). It also counts non-cancelled tasks that still have no `task.external.linear` and fails after login until `orch integration retry` or the next orch process creates those issues.
- Desktop Linear and Cursor Linear MCP cannot sign this CLI. MCP is fine for interactive agent lookups; task create/status/proof mirroring is GraphQL in ORCH, not `@linear/sdk` and not an MCP conversation.
- Do not store API keys on the task.
- Do not create a second Linear issue for the same ORCH task id.
