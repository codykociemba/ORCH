---
name: code-admission
version: 1.0.0
description: |
  Watcher-owned reuse-first admission. Strong GitNexus/ledger hits skip the LLM.
---

# Code admission

- Search existing code with GitNexus (`orch code search` / `orch code impact`) before creating anything.
- Fast-path contracts allow edits in scope only. `allowed_new_files`, `allowed_new_symbols`, and `allowed_dependencies` start empty.
- Request creates with `orch admission request --task <id> --type new_file|new_symbol|new_dependency`.
- The running ORCH watcher decides. You never approve your own request.
- Exact path / exact symbol / reserved name → auto-reject, reuse the existing surface, optionally `depends_on` the owner.
- Unapproved files/symbols/dependencies fail the merge audit and the task stays in `review`.
