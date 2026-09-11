---
name: workflow
version: 1.0.0
description: |
  ORCH team engineering workflow. ORCH owns scheduling. Compound Engineering
  owns planning/review/learning methodology. Code admission is enforced at merge.
---

# ORCH workflow

- ORCH is the only execution scheduler. Do not run `lfg` or a whole-plan `ce-work` loop against the same task graph.
- Compound Engineering is for `ce-brainstorm`, `ce-plan`, `ce-doc-review`, `ce-code-review`, `ce-simplify-code`, `ce-compound`.
- Unplanned `orch task add` work gets a fast-path Modification Contract: **no new files, symbols, or dependencies**.
- Preferred entry: `orch plan "<goal>"` (same as `orch plan draft`). Then `orch plan verify` for 1–2 units or `orch council <plan.json>` for 5+.
- To create something new, run `orch admission request`. The **watcher** decides. Strong GitNexus/ledger hits auto-reject. Do not self-approve.
- Every task may have `task.external.linear`. Do not create a second Linear issue for the same ORCH task id.
- Linear lifecycle ownership is `linear.status_owner` in `.orch/workflow.yml`: `hybrid` (default), `orch`, or `linear-github`. Hybrid still lets ORCH set task/review/verified states.
- Proof must bind to the task branch SHA. A new commit invalidates a prior Verified stamp when the semantic diff changed.
- Dispatch prompts include worker GitNexus identity (`repository_root`, `worktree_path`, `branch`, `base_sha`, `head_sha`) and prior `docs/solutions` learnings. When a meaningful goal is achieved, ORCH appends GitNexus architecture seams onto that note so later plans do not get a "task passed" stub. Plan, council, proof, and worker dispatch skip `status: stale` notes (`ce-compound-refresh`); doctor reports the stale count without failing the run.
- PRs should reference the Linear identifier when Linear is enabled.
- GitNexus is the sole code graph. Do not invent a second index.

## Before coding

ORCH/CE + GitNexus discover the existing implementation seams (`orch code search|impact|context|query`). Non-trivial plan units must record existing-code analysis and alternatives to any proposed create.

## During coding

Workers operate under a Modification Contract. Unplanned work is zero-create. Need something new? Stop that portion and run:

```text
orch admission request new-file --task <id> --path <file> --need "..." --why-not-reuse "..."
orch admission request new-symbol --task <id> --name <symbol> --path <file>
orch admission request dependency --task <id> --package <name>
orch admission request scope --task <id>
```

The watcher decides. Strong exact GitNexus/ledger hits skip the LLM and reject the create. Workers never self-approve.

MEDIUM impact edits need tests for dependents. HIGH/CRITICAL edits need an approved `high_risk_edit` and use `review.high_risk_policy` (`human_and_cursor` here). CRITICAL also needs independent Cursor/Codex/Claude review. UNKNOWN is not LOW.

## After coding

Git + GitNexus independently compare the actual diff with approvals (`orch admission audit`). When `conventions.enabled` is set, that audit also enforces header-only comments and no parallel util files, emits `workspace:conventions_passed` or `workspace:conventions_failed`, and writes the conventions report onto `task.feedback`. Worktree merge-back refuses when that audit fails or is incomplete. Only then: tests / review / proof / merge. Proof binds to HEAD SHA. Failed admission cannot be Verified.

When `.orch/workflow.yml` has `conventions.enabled: true`, the watcher injects the loaded conventions YAML on every dispatch (not via the skill loader, not a second hardcoded essay). `orch init` and `orch workflow setup` write `.orch/conventions.yml` if missing, and merge only absent keys into a user-edited copy. The container loads that file (then `.orchestry/conventions.yml` as a local override) onto the same conventions object the merge/proof gates already use. They are merge-blocking:

1. Prefer editing an existing file or function. Do not create a sibling util/helper/lib file for behavior that belongs in an existing module.
2. New files only under: `src/`, `test/`, `docs/`. New files matching `**/utils/**`, `**/helpers/**`, `**/lib/misc/**` are rejected.
3. At most 8 new files per task.
4. Comments: one file-header comment only, 1–4 short overview lines. No inline comments. No JSDoc on functions. Allowed exceptions: eslint-disable, @ts-expect-error, @ts-ignore, c8 ignore. `//` inside strings, template literals, and regexes is not a comment. A shebang and a leading `'use strict'` may precede the header.
5. If you need a new file or a new top-level function, request it with `orch admission request` and keep the surface small.

## Wiki

- `code_intelligence.required: true` makes `orch doctor` fail closed when GitNexus is missing (native Windows skip becomes fail). Doctor also creates a temporary `.orchestry/doctor-detect-wt` worktree and proves `detect_changes` is bound to it.
- Merge-gate rules live in `.orch/workflow.yml`. `.orch/conventions.yml` is an optional overlay; doctor does not fail when the overlay is absent.
- `orch workflow setup` sets `code_admission.enabled` and `code_intelligence.required` on an existing `.orch/workflow.yml`, merges `code_intelligence.pdg.required_for` (security/auth/payments/concurrency/dataflow-sensitive), generates the local wiki, and, when `code_intelligence.setup.auto_analyze` is true (default), runs `gitnexus analyze`. Use `--analyze` to force it. Sensitive reuse analysis requests `--pdg`; setup does not run PDG on every trivial project.
- Generate locally with `orch wiki generate` / `orch wiki preview`. That never publishes the canonical wiki. If the GitNexus index is stale, generate tries `analyze --index-only` first (fail-open). A still-stale index is not treated as architectural truth — generate still writes pages and warns; automatic `--force` (env/config) is stripped unless the caller passed `--force`; wiki evidence reports `failed` and omits published page counts; `orch wiki publish` refuses. `orch pr create` uses the same generate path.
- Canonical publish is `orch wiki publish` on the default branch (or CI `wiki-publish.yml`). Preview/publish CI calls `orch wiki generate` (not raw `gitnexus wiki`) so stale-index `--force` stripping applies. Use `--force` only as a human override. Bootstrap-required publish exits 1 so default-branch CI does not look green. GitLab wiki API calls time out at 15s and retry twice on timeout, 429, or 5xx. GitHub wiki `git clone` / `git push` retry twice on a transient failure. The first-page bootstrap `HEAD:master` push retries the same way before falling back to `_new`.
- GitHub first-page bootstrap is a one-time human action: enable Wiki and create any first page. Then ORCH owns generated pages. `orch doctor` probes the remote wiki and Linear team (not just “credential file present”). When `linear.enabled` is true, missing `orch integration login` is a doctor fail even if `required_before_dispatch` is false. `gitnexus current` fail includes the freshness reason (`stale`, `content-drift`) when the index SHA is present but the working tree drifted. Doctor also names Claude / Cursor / Codex integration checks (council and review leads). Workflow-critical doctor failures (wiki, Linear, GitNexus freshness, gh, team files, missing Claude/Cursor/Codex) set `process.exitCode = 1`; missing optional adapters do not.
- Enterprise / self-hosted remotes: set `wiki.github_hosts` or `wiki.gitlab_hosts` in `.orch/workflow.yml`. Optional `wiki.gitlab.api_url` overrides the GitLab wiki API base; otherwise ORCH uses `CI_API_V4_URL` / `GITLAB_API_URL`, then the origin host, then gitlab.com. Public `github.com` / `gitlab.com` stay auto-detected. Mixed GitHub+GitLab remotes fail closed.
