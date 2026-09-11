# Team engineering workflow

ORCH is the only execution scheduler. Compound Engineering owns planning, review, and durable learnings. GitNexus is the only code graph.

Do not run Compound Engineering `lfg` or whole-plan `ce-work` against the same task graph.

## Config

| File | Role |
|---|---|
| `.orch/workflow.yml` | Admission, Linear, council, Ponytail, wiki |
| `.orch/compound.yml` | CE methodology; `scheduler: orch` |
| `.orch/conventions.yml` | Optional overlay; merge-gate rules already live in `.orch/workflow.yml` |
| `.orch/workflow.yml` `code_admission.enabled` | On after `orch init`; existing repos opt in with `orch workflow setup` |
| `.orch/workflow.yml` `code_intelligence.required` | On after `orch init`; `orch doctor` fails closed if GitNexus is missing |

`orch init` writes `.orch/workflow.yml` with admission, conventions, and required GitNexus, plus `.orch/compound.yml`. `.orch/conventions.yml` is written if missing; a user-edited copy only receives absent keys. Dispatch injects the loaded conventions YAML, not a second hardcoded copy. Existing projects stay compatible until they run `orch workflow setup`, which turns on `code_admission.enabled` and `code_intelligence.required` on an existing `.orch/workflow.yml`, merges `pdg.required_for` for security/auth/payments/concurrency/dataflow-sensitive reuse, and merges missing convention keys the same way.

Secrets stay out of git:

```bash
LINEAR_API_KEY=          # or: orch integration login
CURSOR_API_KEY=          # GitHub Actions secret for trusted same-repo PR review
GITNEXUS_WIKI_API_KEY=   # CI wiki generate
```

## Commands

```bash
orch workflow doctor
orch workflow setup --analyze
orch plan "<goal>"                    # same as orch plan draft
orch plan reuse <queries...>
orch plan verify <plan.json>          # 1–2 units: Codex, fail-closed; required before import
orch council <plan.json>              # same as orch council convene
orch council override <planId> --reason "…"
orch plan import <plan.json>
orch code search|query|context|impact|detect|status
orch admission request|show|audit
orch integration login                # Linear personal API key (not desktop/MCP)
orch proof publish <task>
orch wiki generate|status|publish     # publish is default-branch only
```

## Gates

- Unplanned tasks start with a zero-create Modification Contract.
- Council-required plans persist at `.orch/plans/<id>.json` and do not pre-authorize creates until council **approve**. Every invited member must approve; a missing CLI is fail-closed. 3–4 unit plans also require council for auth, payments, migrations, infra, and similar topics.
- Mid-task creates go through `orch admission request`. The watcher decides. Workers never self-approve.
- Strong exact GitNexus/ledger hits skip the LLM and reject the create.
- Git + GitNexus audit runs before worktree merge-back. Failed admission cannot be Verified.
- Proof binds to HEAD SHA. A new commit replaces any prior Verified stamp; only the current HEAD can be Verified.
- Canonical wiki publish is default-branch only. An empty GitHub wiki needs one human bootstrap page.

## Linear and GitHub

Linear mirroring is deterministic (`task.external.linear`) when `linear.enabled` is true. Desktop Linear and Cursor Linear MCP cannot authenticate this CLI — use `orch integration login` or `LINEAR_API_KEY`. When `depends_on` issues already exist, ORCH creates Linear `blockedBy` relations (and still lists the ORCH ids on the issue).

PRs use Linear magic words and ORCH task/plan fields. Cursor automated review runs on trusted same-repo PRs when `CURSOR_API_KEY` is set; fork PRs are skipped.

## Code intelligence and admission

```text
Before coding:
ORCH/CE + GitNexus discover the existing implementation seams.

During coding:
workers operate under a Modification Contract.

Need something new:
worker asks ORCH to admit it (`orch admission request`). The watcher decides.

After coding:
Git + GitNexus independently compare actual changes with approvals.

Only then:
tests / review / proof / merge.
```

`orch plan reuse` / `orch plan draft` query GitNexus for existing symbols **and** execution processes. Council receives those hits plus proposed-create alternatives. GitNexus is the only repository graph. Do not add CodeGraphContext, Serena, or a second index.

## Host install

Compound Engineering stays a host plugin. Do not vendor it into `skills/library/`.

| Host | Install |
|---|---|
| Claude Code | Install the Compound Engineering plugin; use `ce-brainstorm` / `ce-plan` / `ce-compound`. ORCH remains the scheduler. |
| Cursor | Same CE plugin plus `.cursor/rules/orch-workflow.mdc` and `.cursor/rules/orch-code-admission.mdc`. |
| Codex | Use CE for planning/review only. `orch plan verify` is the Codex reuse gate. |

Linear: `orch integration login` or `LINEAR_API_KEY`. Enable Linear's native GitHub integration so `Fixes ENG-123` links the PR.

Cursor PR review: add repository secret `CURSOR_API_KEY`. The Action is read-only and skipped on fork PRs.

## Ponytail

Ponytail is a behavioral nudge, not an authority. Planning/council default off. Implementation defaults to lite. Acceptance criteria and admission always win.
