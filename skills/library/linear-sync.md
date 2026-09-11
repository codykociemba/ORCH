---
name: linear-sync
version: 1.0.0
description: |
  Linear mirroring is deterministic application code. Never create a duplicate
  issue because an API response was lost.
---

# Linear sync

- Use `task.external.linear` (`id`, `identifier`, `url`).
- Idempotency fingerprint is the ORCH task id. Look up before create.
- If `linear.required_before_dispatch` is true, the watcher will not dispatch until the issue exists.
- Retry with `orch integration retry linear <task-id>`.
- Authenticate with `orch integration login` (stores `~/.orchestry/linear.token`). Env `LINEAR_API_KEY` still wins if set.
- Do not store API keys on the task.
