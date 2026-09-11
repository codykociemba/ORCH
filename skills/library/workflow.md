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
- To create something new, run `orch admission request`. The **watcher** decides. Strong GitNexus/ledger hits auto-reject. Do not self-approve.
- Every task may have `task.external.linear`. Do not create a second Linear issue for the same ORCH task id.
- Proof must bind to the current HEAD SHA. A new commit invalidates a prior Verified stamp when the semantic diff changed.
- PRs should reference the Linear identifier when Linear is enabled.
- GitNexus is the sole code graph. Do not invent a second index.
