---
name: council
version: 1.0.0
description: |
  Independent multi-model plan review. Required for 5+ task plans and high-risk
  3–4 task plans. Council does not schedule work.
---

# Council

ORCH remains the scheduler. Council only validates a plan.

- 1–2 tasks: Claude plans, Codex verifies. `orch plan verify` fail-closes on UNKNOWN impact, on HIGH/CRITICAL/UNKNOWN symbols left in `recommended_edits`, and on proposed creates next to those seams. Codex cannot override that.
- 3–4 tasks: Claude + Codex; Council only if high-risk / cross-cutting / uncertain.
- 5+ tasks: Council required (Claude + Codex + Cursor Grok). Independent repo inspection.
- Attach GitNexus reuse evidence, including blast radius. Strong existing hits mean "edit that symbol," not "create a twin." Watcher search, `orch code search`, and plan draft/reuse also return global admission reservations so another task's reserved path is existing code, not a proposed create. HIGH/CRITICAL or UNKNOWN impact is not automatic reuse and is not written to `recommended_edits` (that list would otherwise authorize the edit). Process hits keep their GitNexus file path when one exists. Council JSON marks `gitnexus_evidence.incomplete` when any candidate has UNKNOWN impact, or when security/auth/payments/concurrency/dataflow-sensitive reuse could not run `analyze --pdg`.
- Run `orch council <plan.json>` (or `orch council convene`) for independent Claude + Codex + Cursor (Grok 4.6) votes. Missing members fail closed (`revise`). A first-pass revise triggers a second independent round with a changelog of strongest objections — members still do not see each other's raw replies. The stored council JSON records `plan_digest` (computed from the plan title and units when the imported plan omitted one) so later dispatch can identify the exact plan version reviewed.
- Revise/reject does not set `council_ref`. A human may record `orch council override <planId> --reason …` to unlock dispatch only; that does not authorize new files. The override is audited (event + `.orch/plans/<plan>-council-override.json`) and never rewrites the council verdict to approve.
- Council-required plans do not pre-authorize `proposed_creates` until an approve.
- If Council revises a previously approved 5+ plan, mid-task admission that changes the plan shape goes back to Council.
