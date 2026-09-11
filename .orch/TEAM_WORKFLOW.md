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

1. Unplanned `orch task add` gets a zero-create Modification Contract.
2. Planned work may pre-authorize creates via the CE plan reuse section (`orch plan import`).
3. Mid-task creates: `orch admission request`. The watcher decides. Strong GitNexus/ledger hits skip the LLM.
4. Fuzzy cases go to Claude; high/critical or disagreement go to Codex; material changes to a Council-approved 5+ plan go to Council.
5. Git + GitNexus audit runs before `mergeBack`. Failed admission cannot be Verified.

## Planning / Council

```text
1–2 units   Claude plans, Codex verifies
3–4 units   + Council only if high-risk
5+ units    Council required (Claude + Codex + Cursor Grok)
```

`orch plan validate|import|reuse` routes and creates tasks. `orch council convene|save` records independent Claude/Codex/Cursor (Grok 4.6) votes. Tasks labeled `council-required` do not dispatch until `council_ref` is set.

## Linear / proof / wiki

- One Linear issue per ORCH task when `linear.enabled` is true. Idempotent on task id.
- `orch pr body|create` emits `Fixes ENG-123` and a Linear-prefixed title.
- `orch proof publish` comments Linear and/or the linked GitHub PR. Same SHA is not duplicated.
- `orch review ingest` stores Cursor/human ReviewEvidence bound to HEAD.
- Proof binds to HEAD SHA. A new commit invalidates Verified.
- Wiki preview is allowed on PRs. Canonical `orch wiki publish` / `wiki-publish.yml` is default-branch only.

## Runtime

GitNexus natives: Linux / macOS / WSL2. Native Windows is best-effort.
