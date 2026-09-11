---
name: proof
version: 1.0.0
description: |
  Verification proof published to GitHub and Linear. Admission failure cannot
  be marked Verified.
---

# Proof

- Bind proof to the current HEAD SHA.
- Include code-admission PASS/FAIL and violations.
- `orch proof <task-id>` renders the GitHub section.
- `orch proof publish <task-id>` comments Linear when configured.
- A failed or incomplete admission audit prevents Verified.
