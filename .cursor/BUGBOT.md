# Bugbot / Cursor review notes for ORCH

Review PRs against the team workflow in `.orch/workflow.yml` and `.cursor/rules/orch-workflow.mdc`.

Look for:

- New files, exported symbols, or dependencies that have no admission request / contract entry
- A second code graph or homemade symbol index
- Compound Engineering schedulers racing ORCH
- Duplicate Linear issues (missing `task.external.linear` lookup)
- Wiki publish from a feature-branch HEAD
- Proof marked Verified without a HEAD SHA or after a failed admission audit
