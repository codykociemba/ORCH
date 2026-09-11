/**
 * Minimal MCP JSON-RPC client over stdio (Content-Length framing).
 *
 * Used for GitNexus graph tools. Always pass repo + worktree in tool args.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { IMcpToolCaller } from './interface.js';
import { gitnexusBin, gitnexusCliEnv, resolveGitnexusSpawn } from './cli-runner.js';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class McpStdioClient implements IMcpToolCaller {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
  }>();
  private initialized = false;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly cwd?: string,
  ) {}

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureInitialized();
    const result = await this.request('tools/call', { name, arguments: args });
    return unwrapToolResult(result);
  }

  async close(): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    proc.stdin?.end();
    proc.kill('SIGTERM');
    for (const [, waiter] of this.pending) {
      waiter.reject(new Error('MCP client closed'));
    }
    this.pending.clear();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.spawn();
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'orch', version: '1.0.34' },
    });
    this.notify('notifications/initialized', {});
    this.initialized = true;
  }

  private spawn(): void {
    if (this.proc) return;
    const invoked = resolveGitnexusSpawn(this.command, this.args, this.cwd);
    const proc = spawn(invoked.command, invoked.args, {
      cwd: this.cwd,
      env: gitnexusCliEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = proc;
    proc.stdout?.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.consume();
    });
    proc.stderr?.on('data', () => {
      // Provider logs — ignore for the RPC path.
    });
    proc.on('error', (err) => {
      for (const [, waiter] of this.pending) waiter.reject(err);
      this.pending.clear();
    });
    proc.on('close', () => {
      this.initialized = false;
      this.proc = null;
    });
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write(payload);
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private write(payload: unknown): void {
    if (!this.proc?.stdin) throw new Error('MCP process is not running');
    const body = JSON.stringify(payload);
    const message = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
    this.proc.stdin.write(message);
  }

  private consume(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString('utf8');
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch?.[1]) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(lengthMatch[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.subarray(start, start + length).toString('utf8');
      this.buffer = this.buffer.subarray(start + length);
      this.dispatch(body);
    }
  }

  private dispatch(body: string): void {
    let parsed: JsonRpcResponse;
    try {
      parsed = JSON.parse(body) as JsonRpcResponse;
    } catch {
      return;
    }
    if (parsed.id === undefined) return;
    const waiter = this.pending.get(parsed.id);
    if (!waiter) return;
    this.pending.delete(parsed.id);
    if (parsed.error) {
      waiter.reject(new Error(parsed.error.message));
      return;
    }
    waiter.resolve(parsed.result);
  }
}

function unwrapToolResult(result: unknown): unknown {
  if (typeof result === 'string') return parseGitNexusToolText(result);
  if (!result || typeof result !== 'object') return result;
  const record = result as { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown };
  if (typeof record.structuredContent === 'string') return parseGitNexusToolText(record.structuredContent);
  if (record.structuredContent !== undefined) return record.structuredContent;
  const text = record.content?.find((part) => part.type === 'text')?.text;
  if (!text) return result;
  return parseGitNexusToolText(text);
}

/** GitNexus appends a "Next:" hint after the JSON payload. */
export function parseGitNexusToolText(text: string): unknown {
  const trimmed = text.trim();
  const withoutHint = trimmed.split(/\n---\n/)[0]?.trim() ?? trimmed;
  try {
    return JSON.parse(withoutHint);
  } catch {
    /* try a brace slice on the hint-free chunk */
  }
  const start = withoutHint.indexOf('{');
  const end = withoutHint.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(withoutHint.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  return text;
}

export function defaultGitNexusMcpArgs(): { command: string; args: string[] } {
  const command = process.env['GITNEXUS_MCP_COMMAND'] ?? gitnexusBin();
  const extra = process.env['GITNEXUS_MCP_ARGS'];
  const args = extra ? extra.split(/\s+/).filter(Boolean) : ['mcp'];
  return { command, args };
}
