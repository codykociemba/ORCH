/**
 * GitNexus-backed ICodeIntelligence.
 *
 * Graph ops go through MCP with explicit repo + worktree.
 * Lifecycle (status / analyze) goes through the CLI.
 */

import { CodeIntelligenceError } from '../../domain/errors.js';
import type {
  CodeCandidate,
  CodeIndexStatus,
  DetectCodeChangesInput,
  ExistingCodeSearchInput,
  ExecutionProcess,
  ImpactInput,
  ImpactReport,
  ImpactRisk,
  ProcessQueryInput,
  RepositoryIdentityInput,
  SemanticChangeSet,
  SemanticSymbolChange,
  SymbolContext,
  SymbolContextInput,
} from '../../domain/code-intelligence.js';
import type { ICliRunner, ICodeIntelligence, IMcpToolCaller } from './interface.js';
import { ExecFileCliRunner, gitnexusBin, gitnexusCliEnv, toWslPath } from './cli-runner.js';
import { McpStdioClient, defaultGitNexusMcpArgs, parseGitNexusToolText } from './mcp-stdio-client.js';

export interface GitNexusAdapterOptions {
  projectRoot: string;
  mcp?: IMcpToolCaller;
  cli?: ICliRunner;
  repoName?: string;
}

export class GitNexusCodeIntelligence implements ICodeIntelligence {
  private readonly projectRoot: string;
  private readonly mcp?: IMcpToolCaller;
  private readonly cli: ICliRunner;
  private readonly repoName?: string;
  private readonly resolveBin: boolean;

  constructor(options: GitNexusAdapterOptions) {
    this.projectRoot = options.projectRoot;
    this.mcp = options.mcp;
    this.resolveBin = !options.cli;
    this.cli = options.cli ?? new ExecFileCliRunner();
    this.repoName = options.repoName;
  }

  async getRepositoryStatus(input: RepositoryIdentityInput): Promise<CodeIndexStatus> {
    const cwd = input.worktree_path ?? input.repository_root ?? this.projectRoot;
    const result = await this.cli.run(this.bin(), ['status', '--json'], cwd);
    if (result.code !== 0) {
      return {
        provider: 'gitnexus',
        repo: input.repo ?? this.repoName ?? inferRepoName(cwd),
        available: false,
        current: false,
        incomplete_reasons: [result.stderr.trim() || `gitnexus status exited ${result.code}`],
      };
    }
    const parsed = parseJsonObject(result.stdout);
    const index = asObject(parsed['index']);
    const drift = asObject(parsed['contentDrift'] ?? parsed['content_drift']);
    const error = stringish(parsed['error']);
    const incomplete = asStringArray(
      parsed['incomplete']
      ?? parsed['incomplete_reasons']
      ?? parsed['reasons']
      ?? index['incompleteReasons']
      ?? index['incomplete_reasons'],
    );
    if (error) incomplete.push(error);
    const statusWord = stringish(parsed['status']);
    const driftStatus = stringish(drift['status']);
    if (statusWord === 'stale') incomplete.push('stale');
    if (driftStatus === 'drifted') incomplete.push('content-drift');
    const currentFlag = booleanish(parsed['current'] ?? parsed['index_current'] ?? parsed['fresh'] ?? parsed['indexed']);
    const indexed = error !== 'not-indexed' && parsed['error'] !== true && (Boolean(index['commit']) || currentFlag === true || statusWord === 'current' || statusWord === 'stale');
    const current = indexed && (
      currentFlag === true
      || statusWord === 'current'
      || (currentFlag === undefined && statusWord !== 'stale' && driftStatus !== 'drifted' && incomplete.filter((item) => item !== 'not-indexed').length === 0)
    );
    return {
      provider: 'gitnexus',
      repo: stringish(parsed['repo'] ?? parsed['name'] ?? parsed['repository']) ?? input.repo ?? this.repoName ?? inferRepoName(cwd),
      available: indexed,
      current,
      index_commit: stringish(
        index['commit']
        ?? parsed['index_commit']
        ?? parsed['commit']
        ?? parsed['sha'],
      ),
      incomplete_reasons: incomplete,
      raw: parsed,
    };
  }

  async analyze(input: RepositoryIdentityInput): Promise<void> {
    const cwd = input.worktree_path ?? input.repository_root ?? this.projectRoot;
    const pdg = Boolean((input as { pdg?: boolean }).pdg);
    const result = await this.cli.run(this.bin(), pdg ? ['analyze', '--pdg'] : ['analyze'], cwd, gitnexusCliEnv());
    if (result.code !== 0) {
      throw new CodeIntelligenceError(
        'GitNexus analyze failed',
        result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`,
      );
    }
  }

  async searchExisting(input: ExistingCodeSearchInput): Promise<CodeCandidate[]> {
    const repo = this.repo(input.repo) ?? this.projectRoot;
    const raw = await this.call('query', {
      search_query: input.query,
      query: input.query,
      repo,
      limit: input.limit ?? 10,
    });
    const hits = candidatesFromQuery(raw);
    if (hits.length > 0) return hits;
    const limit = Math.max(1, Math.min(input.limit ?? 10, 50));
    const folded = foldSearchNeedle(input.query);
    const cypher = await this.call('cypher', {
      statement:
        'MATCH (n) WHERE n.name CONTAINS $q OR n.name CONTAINS $folded OR n.filePath CONTAINS $q '
        + `RETURN n.name AS name, n.filePath AS path LIMIT ${limit}`,
      params: { q: input.query, folded },
      repo,
    });
    return candidatesFromQuery(cypher);
  }

  async getSymbolContext(input: SymbolContextInput): Promise<SymbolContext> {
    const raw = await this.call('context', {
      name: input.symbol,
      symbol: input.symbol,
      file_path: input.path,
      repo: this.repo(input.repo) ?? this.projectRoot,
    });
    const obj = asObject(raw);
    return {
      symbol: stringish(obj['symbol']) ?? input.symbol,
      path: stringish(obj['path'] ?? obj['file'] ?? obj['filePath'] ?? obj['file_path']) ?? input.path,
      kind: stringish(obj['kind'] ?? obj['type']),
      callers: asStringArray(obj['callers'] ?? obj['upstream']),
      callees: asStringArray(obj['callees'] ?? obj['downstream']),
      processes: [...new Set([
        ...asStringArray(obj['processes']),
        ...asStringArray(obj['affected_processes']),
      ])],
      raw,
    };
  }

  async getImpact(input: ImpactInput): Promise<ImpactReport> {
    const raw = await this.call('impact', {
      target: input.target,
      direction: input.direction ?? 'upstream',
      repo: this.repo(input.repo) ?? this.projectRoot,
    });
    const obj = asObject(raw);
    const summary = asObject(obj['summary']);
    const risk = normalizeRisk(stringish(obj['risk'] ?? obj['severity'] ?? obj['risk_level']));
    const unresolved = booleanish(obj['unresolved'] ?? obj['unknown'] ?? obj['partial']) ?? risk === 'unknown';
    return {
      target: stringish(obj['target'] ?? asObject(obj['target'])['name']) ?? input.target,
      risk,
      direct_dependents: numberish(
        obj['direct_dependents'] ?? obj['direct'] ?? summary['direct'] ?? summary['direct_callers'],
      ) ?? 0,
      total_dependents: numberish(
        obj['total_dependents'] ?? obj['total'] ?? obj['impactedCount'] ?? summary['total'] ?? summary['impactedCount'],
      ) ?? 0,
      processes: [...new Set([
        ...asStringArray(obj['processes']),
        ...asStringArray(obj['affected_processes']),
      ])],
      unresolved,
      raw,
    };
  }

  async getProcesses(input: ProcessQueryInput): Promise<ExecutionProcess[]> {
    const raw = await this.call('query', {
      search_query: input.query ?? 'processes',
      query: input.query ?? 'processes',
      repo: this.repo(input.repo) ?? this.projectRoot,
    });
    const obj = asObject(raw);
    const rows = [
      ...asArray(obj['processes']),
      ...asArray(obj['affected_processes']),
      ...asArray(obj['process_symbols']),
    ];
    if (rows.length === 0) rows.push(...asArray(raw));
    const seen = new Set<string>();
    const processes: ExecutionProcess[] = [];
    for (const item of rows) {
      const row = asObject(item);
      const name = stringish(row['name'] ?? row['process'] ?? row['symbol'] ?? row['label'])
        ?? (typeof item === 'string' ? item : '');
      if (!name || name === 'unknown' || seen.has(name)) continue;
      seen.add(name);
      const filePath = stringish(row['filePath'] ?? row['file_path'] ?? row['path']);
      const steps = asStringArray(row['steps']);
      processes.push({
        name,
        steps: filePath && !steps.includes(filePath) ? [filePath, ...steps] : steps,
      });
    }
    return processes;
  }

  async close(): Promise<void> {
    await this.mcp?.close();
  }

  async detectChanges(input: DetectCodeChangesInput): Promise<SemanticChangeSet> {
    if (!input.worktree) {
      throw new CodeIntelligenceError('detect_changes requires an explicit worktree');
    }
    const raw = await this.call('detect_changes', {
      repo: this.repo(input.repo) ?? this.projectRoot,
      worktree: this.forGitnexus(input.worktree),
      scope: input.scope ?? 'all',
      base_sha: input.base_sha,
      base_ref: input.base_sha,
    });
    const obj = asObject(raw);
    const changed = partitionChangedSymbols(obj['changed_symbols'] ?? obj['changedSymbols']);
    return {
      added_symbols: [
        ...toSymbolChanges(obj['added_symbols'] ?? obj['added'], 'added'),
        ...changed.added,
      ],
      modified_symbols: [
        ...toSymbolChanges(obj['modified_symbols'] ?? obj['modified'], 'modified'),
        ...changed.modified,
      ],
      deleted_symbols: [
        ...toSymbolChanges(obj['deleted_symbols'] ?? obj['deleted'], 'deleted'),
        ...changed.deleted,
      ],
      processes: [...new Set([
        ...asStringArray(obj['processes']),
        ...asStringArray(obj['affected_processes']),
      ])],
      risk: normalizeRisk(stringish(obj['risk'] ?? obj['risk_level'])),
      partial: booleanish(obj['partial']) ?? false,
      truncated: booleanish(obj['truncated']) ?? false,
      degraded: booleanish(obj['degraded']) ?? false,
      worktree: input.worktree,
      raw,
    };
  }

  private bin(): string {
    return this.resolveBin ? gitnexusBin() : 'gitnexus';
  }

  private repo(explicit?: string): string | undefined {
    const value = explicit ?? this.repoName ?? this.projectRoot;
    return value ? this.forGitnexus(value) : undefined;
  }

  private forGitnexus(localPath: string): string {
    if (gitnexusBin() === 'wsl-gitnexus') return toWslPath(localPath);
    return localPath;
  }

  private async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.mcp) {
      throw new CodeIntelligenceError(
        'GitNexus MCP client is not configured',
        'Pass repo + worktree via ORCH; install gitnexus and set GITNEXUS_BIN / GITNEXUS_MCP_COMMAND',
      );
    }
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined) cleaned[key] = value;
    }
    const result = await this.mcp.callTool(name, cleaned);
    return typeof result === 'string' ? parseGitNexusToolText(result) : result;
  }
}

export interface GitNexusIntelligenceHandle {
  intelligence: GitNexusCodeIntelligence;
  close: () => Promise<void>;
}

/** Shared MCP + CLI wiring for light CLI commands and the watcher. */
export function createGitNexusIntelligence(projectRoot: string, repoName?: string): GitNexusIntelligenceHandle {
  const spec = defaultGitNexusMcpArgs();
  const mcp = new McpStdioClient(spec.command, spec.args, projectRoot);
  const intelligence = new GitNexusCodeIntelligence({ projectRoot, mcp, repoName });
  const rawSearchExisting = intelligence.searchExisting.bind(intelligence);
  intelligence.searchExisting = async (input) => {
    let hits: Awaited<ReturnType<typeof rawSearchExisting>> = [];
    try {
      hits = await rawSearchExisting(input);
    } catch {
      hits = [];
    }
    const needle = input.query.trim().toLowerCase();
    if (!needle) return hits;
    try {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const raw = JSON.parse(
        await readFile(join(projectRoot, '.orchestry', 'admission', 'reservations.json'), 'utf8'),
      ) as {
        items?: Array<{ path?: string; name?: string; package?: string; kind?: string; task_id?: string }>;
      };
      const seen = new Set(hits.map((hit) => `${hit.path}#${hit.symbol ?? ''}`));
      for (const row of raw.items ?? []) {
        const hay = `${row.path ?? ''} ${row.name ?? ''} ${row.package ?? ''}`.toLowerCase();
        if (!hay.includes(needle)) continue;
        const reservedPath = row.path ?? row.package ?? '';
        const key = `${reservedPath}#${row.name ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        hits.push({
          symbol: row.name,
          path: reservedPath,
          kind: row.kind,
          score: 1,
          snippet: `reserved by ${row.task_id ?? 'unknown'}`,
        });
      }
    } catch {
      // orch code search still returns GitNexus hits when the ledger is missing
    }
    return hits;
  };
  const rawGetImpact = intelligence.getImpact.bind(intelligence);
  const rawGetSymbolContext = intelligence.getSymbolContext.bind(intelligence);
  const rawDetectChanges = intelligence.detectChanges.bind(intelligence);
  intelligence.getImpact = async (input) => {
    const report = await rawGetImpact({
      ...input,
      direction: input.direction ?? 'upstream',
    });
    const extra: string[] = [];
    const rawObj = report.raw && typeof report.raw === 'object' && !Array.isArray(report.raw)
      ? report.raw as Record<string, unknown>
      : {};
    for (const key of ['processes', 'affected_processes']) {
      const rows = rawObj[key];
      if (!Array.isArray(rows)) continue;
      for (const item of rows) {
        if (typeof item === 'string' && item) extra.push(item);
        else if (item && typeof item === 'object' && !Array.isArray(item)) {
          const row = item as Record<string, unknown>;
          const name = [row['process'], row['label'], row['name'], row['symbol']].find((value) => typeof value === 'string' && value);
          if (typeof name === 'string') extra.push(name);
        }
      }
    }
    const processes = [...new Set([...report.processes, ...extra])];
    if (report.unresolved && report.risk !== 'high' && report.risk !== 'critical') {
      return { ...report, risk: 'unknown', processes };
    }
    return { ...report, processes };
  };
  intelligence.getSymbolContext = async (input) => {
    const context = await rawGetSymbolContext(input);
    const extra: string[] = [];
    const rawObj = context.raw && typeof context.raw === 'object' && !Array.isArray(context.raw)
      ? context.raw as Record<string, unknown>
      : {};
    for (const key of ['processes', 'affected_processes']) {
      const rows = rawObj[key];
      if (!Array.isArray(rows)) continue;
      for (const item of rows) {
        if (typeof item === 'string' && item) extra.push(item);
        else if (item && typeof item === 'object' && !Array.isArray(item)) {
          const row = item as Record<string, unknown>;
          const name = [row['process'], row['label'], row['name'], row['symbol']].find((value) => typeof value === 'string' && value);
          if (typeof name === 'string') extra.push(name);
        }
      }
    }
    return { ...context, processes: [...new Set([...context.processes, ...extra])] };
  };
  intelligence.detectChanges = async (input) => {
    const changeset = await rawDetectChanges(input);
    const extra: string[] = [];
    const rawObj = changeset.raw && typeof changeset.raw === 'object' && !Array.isArray(changeset.raw)
      ? changeset.raw as Record<string, unknown>
      : {};
    for (const key of ['processes', 'affected_processes']) {
      const rows = rawObj[key];
      if (!Array.isArray(rows)) continue;
      for (const item of rows) {
        if (typeof item === 'string' && item) extra.push(item);
        else if (item && typeof item === 'object' && !Array.isArray(item)) {
          const row = item as Record<string, unknown>;
          const name = [row['process'], row['label'], row['name'], row['symbol']].find((value) => typeof value === 'string' && value);
          if (typeof name === 'string') extra.push(name);
        }
      }
    }
    return { ...changeset, processes: [...new Set([...changeset.processes, ...extra])] };
  };
  return {
    intelligence,
    close: () => mcp.close(),
  };
}

/**
 * Does not spawn GitNexus until the first graph/CLI call.
 * Light commands that never touch admission pay only a function-object cost.
 */
export function createLazyCodeIntelligence(
  projectRoot: string,
  factory: () => ICodeIntelligence = () => createGitNexusIntelligence(projectRoot).intelligence,
): ICodeIntelligence {
  let inner: ICodeIntelligence | undefined;
  const resolve = (): ICodeIntelligence => {
    inner ??= factory();
    return inner;
  };
  return {
    getRepositoryStatus: (input) => resolve().getRepositoryStatus(input),
    searchExisting: (input) => resolve().searchExisting(input),
    getSymbolContext: (input) => resolve().getSymbolContext(input),
    getImpact: (input) => resolve().getImpact(input),
    getProcesses: (input) => resolve().getProcesses(input),
    detectChanges: (input) => resolve().detectChanges(input),
    analyze: (input) => resolve().analyze?.(input) ?? Promise.resolve(),
    close: async () => {
      await inner?.close?.();
    },
  };
}

function inferRepoName(root: string): string {
  const parts = root.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? 'repo';
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) return {};
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  const candidate = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
  try {
    const parsed: unknown = JSON.parse(candidate);
    return asObject(parsed);
  } catch {
    return { raw: trimmed };
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (Array.isArray(value)) return { items: value };
  return {};
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const obj = asObject(value);
  if (Array.isArray(obj['items'])) return obj['items'];
  if (Array.isArray(obj['results'])) return obj['results'];
  if (Array.isArray(obj['symbols'])) return obj['symbols'];
  if (Array.isArray(obj['process_symbols'])) return obj['process_symbols'];
  if (Array.isArray(obj['definitions'])) return obj['definitions'];
  if (Object.keys(obj).length === 0) return [];
  return [value];
}

function candidatesFromQuery(value: unknown): CodeCandidate[] {
  const obj = asObject(value);
  if (typeof obj['markdown'] === 'string') {
    return parseMarkdownCandidates(obj['markdown']);
  }
  const rows = [
    ...asArray(obj['process_symbols']),
    ...asArray(obj['definitions']),
    ...asArray(obj['symbols']),
    ...asArray(obj['results']),
    ...asArray(obj['items']),
  ];
  if (rows.length === 0 && !obj['process_symbols'] && !obj['definitions']) {
    rows.push(...asArray(value));
  }
  const seen = new Set<string>();
  const hits: CodeCandidate[] = [];
  for (const row of rows) {
    const candidate = toCandidate(row);
    if (!candidate) continue;
    const key = `${candidate.path}#${candidate.symbol ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push(candidate);
  }
  return hits;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'string') return item;
      const obj = asObject(item);
      return stringish(obj['name'] ?? obj['symbol'] ?? obj['path']) ?? '';
    })
    .filter((item) => item.length > 0);
}

function stringish(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberish(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanish(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function normalizeRisk(value: string | undefined): ImpactRisk {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'critical' || value === 'unknown') {
    return value;
  }
  if (!value) return 'unknown';
  const lower = value.toLowerCase();
  if (lower.includes('critical')) return 'critical';
  if (lower.includes('high')) return 'high';
  if (lower.includes('medium')) return 'medium';
  if (lower.includes('low')) return 'low';
  return 'unknown';
}

function foldSearchNeedle(query: string): string {
  if (query.length === 0) return query;
  return query[0]!.toUpperCase() + query.slice(1);
}

function parseMarkdownCandidates(markdown: string): CodeCandidate[] {
  const lines = markdown.split('\n').map((line) => line.trim()).filter((line) => line.includes('|'));
  if (lines.length < 2) return [];
  const headers = (lines[0] ?? '').split('|').map((cell) => cell.trim()).filter(Boolean);
  const hits: CodeCandidate[] = [];
  for (const line of lines.slice(2)) {
    const cells = line.split('|').map((cell) => cell.trim()).filter((cell) => cell !== '---' && cell.length > 0);
    if (cells.length === 0) continue;
    const row: Record<string, unknown> = {};
    headers.forEach((header, index) => {
      row[header] = cells[index];
    });
    const candidate = toCandidate(row);
    if (candidate) hits.push(candidate);
  }
  return hits;
}

function toCandidate(value: unknown): CodeCandidate | null {
  const obj = asObject(value);
  const path = stringish(obj['path'] ?? obj['file'] ?? obj['uri'] ?? obj['filePath'] ?? obj['file_path']);
  const symbol = stringish(obj['symbol'] ?? obj['name']);
  if (!path && !symbol) return null;
  return {
    symbol,
    path: path ?? '',
    kind: stringish(obj['kind'] ?? obj['type']),
    score: numberish(obj['score'] ?? obj['rank']),
    snippet: stringish(obj['snippet'] ?? obj['text']),
  };
}

function partitionChangedSymbols(value: unknown): {
  added: SemanticSymbolChange[];
  modified: SemanticSymbolChange[];
  deleted: SemanticSymbolChange[];
} {
  const added: SemanticSymbolChange[] = [];
  const modified: SemanticSymbolChange[] = [];
  const deleted: SemanticSymbolChange[] = [];
  for (const item of asArray(value)) {
    const obj = asObject(item);
    const changeType = (stringish(obj['change_type'] ?? obj['change'] ?? obj['kind']) ?? 'touched').toLowerCase();
    const mapped = changeType.includes('add')
      ? 'added'
      : changeType.includes('del')
        ? 'deleted'
        : 'modified';
    const row: SemanticSymbolChange = {
      name: stringish(obj['name'] ?? obj['symbol']) ?? 'unknown',
      path: stringish(obj['path'] ?? obj['file'] ?? obj['filePath'] ?? obj['file_path']),
      kind: stringish(obj['type'] ?? obj['kind']),
      change: mapped,
    };
    if (mapped === 'added') added.push(row);
    else if (mapped === 'deleted') deleted.push(row);
    else modified.push(row);
  }
  return { added, modified, deleted };
}

function toSymbolChanges(value: unknown, change: SemanticSymbolChange['change']): SemanticSymbolChange[] {
  return asArray(value).map((item) => {
    if (typeof item === 'string') return { name: item, change };
    const obj = asObject(item);
    return {
      name: stringish(obj['name'] ?? obj['symbol']) ?? 'unknown',
      path: stringish(obj['path'] ?? obj['file'] ?? obj['filePath'] ?? obj['file_path']),
      kind: stringish(obj['kind'] ?? obj['type']),
      change,
    };
  });
}
