# ORCH team workflow

Source of truth: `.orch/workflow.yml` and the engine. Skills document the contract; they are not the gate.

## Who owns what

| Layer | Owner |
|---|---|
| Scheduling, worktrees, retries, admission, Linear sync | ORCH |
| Brainstorm / plan / review / durable learning | Compound Engineering |
| Issue tracker | Linear (when enabled) |
| Commits, PRs, CI, published proof | GitHub |
| Code graph | GitNexus only |

Do not run Compound Engineering `lfg` or a whole-plan `ce-work` loop against the same task graph.

## Code admission

1. Unplanned `orch task add` gets a zero-create Modification Contract. `orch init` in this fork writes `.orch/workflow.yml` with `code_admission.enabled` and `conventions.enabled` on; Linear stays off until `orch integration login`. Existing repos still opt in through `orch workflow setup`.
2. Planned work may pre-authorize creates via the CE plan reuse section (`orch plan import`).
3. Mid-task creates: `orch admission request`. The watcher decides. Strong GitNexus/ledger hits skip the LLM.
4. Fuzzy cases go to Claude; high/critical or disagreement go to Codex; material changes to a Council-approved 5+ plan go to Council.
5. Git + GitNexus audit runs before `mergeBack`. Failed admission cannot be Verified. Shared mode includes untracked files in that audit (`git diff` alone cannot see them). If the shared working tree is dirty beyond `task.proof.files_changed`, the audit fails closed (`cannot attribute convention violations`).
6. When `conventions.enabled` is set, the watcher injects those YAML rules on every dispatch (template wrap — not the skill loader). The same audit (and `orch proof`) rejects parallel util files, files outside `src/` `test/` `docs/`, more than 8 new files, and added inline comments. `orch doctor` reports the gate; `orch admission audit` / `orch proof` are the check. A dedicated `orch conventions` command needs a new CLI register.
7. `orch status` shows the contract (index current/stale, approved files/symbols/deps) and the latest admission request for in-progress and review tasks.

## Planning / Council

```text
1–2 units   Claude plans, Codex verifies
3–4 units   + Council only if high-risk
5+ units    Council required (Claude + Codex + Cursor Grok)
```

`orch plan validate|import|reuse` routes and creates tasks. `orch council convene|save` records independent Claude/Codex/Cursor (Grok 4.6) votes (a second independent round after revise) and writes `docs/plans/<plan>-council.md` plus `.orch/plans/<plan>-council.json`. The plan digest is persisted at `.orch/plans/<plan>.json`. Tasks labeled `council-required` do not dispatch until an **approve** `council_ref` is set. Proposed creates stay unauthorized until that approve (a human override unlocks dispatch only, not the create ledger). Revise/reject artifacts stay on disk and do not unlock dispatch. A human may record `orch council override <planId> --reason …` when the required council cannot complete.

## Linear / proof / wiki

- One Linear issue per ORCH task when `linear.enabled` is true. Idempotent on task id. Mapping is stored on the task and in `.orchestry/integrations/linear/mappings.json`. Type/risk labels are derived from task labels; assignment adds `agent / <adapter>`. Merge comments `### Merged` with the HEAD SHA (and PR URL when present) and moves the issue to Done/Merged.
- `linear.status_owner` (default `hybrid`): `orch` and `hybrid` let ORCH set Todo / In Progress / In Review / Ready for Merge / Done. `linear-github` leaves Linear workflow states to Linear's GitHub automation and still writes ORCH comments and labels.
- Linear issue descriptions include plan/unit, acceptance criteria, and dependencies.
- Worktrees use `orch/ENG-123-short-slug` when a Linear ID exists so GitHub/Linear can link the branch.
- `orch pr body|create` emits `Fixes ENG-123`, ORCH/Verification sections, and `<!-- orch-proof:tsk_…:HEADSHA -->`.
- `orch proof publish` comments Linear and/or the linked GitHub PR, then stores `task.proof.head_sha` + `verified` for that HEAD.
- `orch review ingest` stores Cursor/human ReviewEvidence bound to HEAD.
- Review policy is `human_or_cursor`. High-risk / council-required tasks use `human_and_cursor`.
- Proof binds to HEAD SHA. A new commit replaces Verified; an approve review on an old SHA is not enough.
- Wiki preview is allowed on PRs. Canonical `orch wiki publish` / `wiki-publish.yml` is default-branch only. `wiki.ownership: generated_pages` (default) never deletes unmarked human wiki pages; `full` does.
- GitHub Enterprise / GitLab self-hosted remotes use `wiki.github_hosts` / `wiki.gitlab_hosts`. Mixed GitHub+GitLab remotes fail closed instead of publishing to the wrong host.

## Runtime

GitNexus natives: Linux / macOS / WSL2. Native Windows is best-effort.
