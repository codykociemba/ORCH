---
name: council
version: 1.0.0
description: |
  Independent multi-model plan review. Required for 5+ task plans and high-risk
  3–4 task plans. Council does not schedule work.
---

# Council

ORCH remains the scheduler. Council only validates a plan.

- 1–2 tasks: Claude plans, Codex verifies.
- 3–4 tasks: Claude + Codex; Council only if high-risk / cross-cutting / uncertain.
- 5+ tasks: Council required (Claude + Codex + Cursor Grok). Independent repo inspection.
- Attach GitNexus reuse evidence. Strong existing hits mean "edit that symbol," not "create a twin."
- Run `orch council convene <plan.json>` for independent Claude + Codex + Grok votes. Missing members fail closed (`revise`).
- If Council revises a previously approved 5+ plan, mid-task admission that changes the plan shape goes back to Council.
