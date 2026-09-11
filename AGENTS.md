# AGENTS.md — ORCH

ORCH is the only execution scheduler. Compound Engineering owns planning / review / learning methodology. GitNexus is the sole code graph.

## Before creating anything

1. Search GitNexus (`orch code search` / `orch code impact`) for an existing implementation.
2. Inspect symbol context and processes.
3. Prefer reuse or modification of an existing symbol.
4. If the task Modification Contract does not allow the new file, symbol, or dependency, run `orch admission request`.
5. Do not create it until the watcher approves. Workers never self-approve.
6. ORCH audits the final git + GitNexus diff before merge-back. Hiding a create does not work.

## Invariants

- Do not run Compound Engineering `lfg` or whole-plan `ce-work` against the same task graph.
- Do not add a second index, homemade symbol catalog, CodeGraphContext, or Serena.
- Unplanned tasks start with a zero-create Modification Contract.
- Strong exact GitNexus/ledger hits skip the LLM and reject the create.
- Proof binds to HEAD SHA. Failed admission cannot be Verified.
- Canonical wiki publish is default-branch only.
- One Linear issue per ORCH task when Linear is enabled (`task.external.linear`).

## Commands

```bash
orch workflow doctor
orch workflow setup --analyze
orch admission request|show|audit
orch code search|impact|status|detect
orch plan draft "<goal>"
orch plan validate|import|reuse|verify
orch council convene <plan.json>
orch proof publish <task>
orch review ingest --task <id>
```

Supported GitNexus runtime: Linux / macOS / WSL2. On native Windows, ORCH prefers WSL GitNexus (`GITNEXUS_BIN=wsl`). Set `GITNEXUS_USE_WSL=0` to force the Windows CLI.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **ORCH** (8606 symbols, 24827 relationships, 596 execution flows).

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact before editing.** Use `impact({target: "symbolName", direction: "upstream"})` or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .`; report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). `partial: true` or `truncated: true` is not a clean check — a zero means unseen, not unaffected; re-run it. For regression review: `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- MUST warn on HIGH/CRITICAL `risk` pre-edit; never use `riskSharedAxes` to waive a HIGH/CRITICAL `risk` warning. Compare File/symbol: MCP File omits axes; Graph-RAG expands File.
- **MUST treat `risk: UNKNOWN` as unresolved, not as low.** An empty caller set is not evidence the symbol is unused — it can also mean the callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls). `impact` pairs `UNKNOWN` with a `riskNote` saying so. Confirm with a text search before treating the symbol as safe to change or delete; do not proceed on the strength of a zero.
- **MUST use `query({search_query: "concept"})` for concepts/flows, `context({name: "symbolName"})` for a named symbol, or `impact` for blast radius, on read-only callers, dependencies, imports, or execution flow.** Graph first; text search only for empty/`UNKNOWN`/literals.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read `UNKNOWN` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/ORCH/context` | Codebase overview, check index freshness |
| `gitnexus://repo/ORCH/clusters` | All functional areas |
| `gitnexus://repo/ORCH/processes` | All execution flows |
| `gitnexus://repo/ORCH/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
