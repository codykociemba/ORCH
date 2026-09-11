/**
 * Cursor Agent adapter.
 *
 * Spawns `cursor-agent` (Cursor's headless agent CLI) with `--output-format stream-json`.
 * Falls back to `agent` command if `cursor-agent` is not found.
 * Parses JSON-lines from stdout into AgentEvent stream.
 *
 * Note: This requires Cursor Agent CLI, not the regular `cursor` IDE command.
 * Install via: irm 'https://cursor.com/install?win32=true' | iex  (Windows)
 *              curl https://cursor.com/install -fsS | bash         (macOS/Linux)
 */

import type { IAgentAdapter, AdapterTestResult, ExecuteParams, AgentEvent, ExecuteHandle } from './interface.js';
import type { IProcessManager } from '../process/process-manager.js';
import { extractTokens, createStreamingEvents, buildFullPrompt } from './utils.js';
import { classifyAdapterError, AdapterErrorKind } from '../../domain/errors.js';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function cursorAgentCandidates(): string[] {
  const localApp = process.env['LOCALAPPDATA'] ?? '';
  return [
    'cursor-agent',
    'agent',
    path.join(localApp, 'cursor-agent', 'cursor-agent.cmd'),
    path.join(localApp, 'cursor-agent', 'agent.cmd'),
    path.join(homedir(), '.local', 'bin', 'cursor-agent'),
    path.join(homedir(), '.local', 'bin', 'agent'),
  ].filter((candidate, index, all) => Boolean(candidate) && all.indexOf(candidate) === index);
}

function invokeCursor(cmd: string, args: string[]): { command: string; args: string[] } {
  if (cmd.toLowerCase().endsWith('.cmd')) {
    return { command: process.env['ComSpec'] ?? 'cmd.exe', args: ['/d', '/s', '/c', cmd, ...args] };
  }
  return { command: cmd, args };
}

function cursorLoginHint(cmd: string): string {
  const resolved = cmd.includes(path.sep)
    ? cmd
    : path.join(process.env['LOCALAPPDATA'] ?? '', 'cursor-agent', 'agent.cmd');
  return `Cursor Agent is installed but not logged in. In this PowerShell window run: $env:PATH = "$env:LOCALAPPDATA\\cursor-agent;$env:PATH"; agent login   (or: & "${resolved}" login)`;
}

/** Try PATH names, then the official Windows install location. */
async function findCommand(): Promise<{ command: string; version: string } | null> {
  for (const cmd of cursorAgentCandidates()) {
    if (cmd.includes(path.sep) && !existsSync(cmd)) continue;
    try {
      const invoked = invokeCursor(cmd, ['--version']);
      const { stdout } = await execFileAsync(invoked.command, invoked.args, { windowsHide: true });
      return { command: cmd, version: stdout.trim() };
    } catch {
      // try next
    }
  }
  return null;
}

async function isCursorLoggedIn(cmd: string): Promise<boolean> {
  if (process.env['CURSOR_API_KEY']) return true;
  try {
    const invoked = invokeCursor(cmd, ['status']);
    const { stdout, stderr } = await execFileAsync(invoked.command, invoked.args, { windowsHide: true });
    const text = `${stdout}\n${stderr}`;
    return !/not logged in|authentication required/i.test(text);
  } catch {
    return false;
  }
}

export class CursorAdapter implements IAgentAdapter {
  readonly kind = 'cursor';

  private resolvedCommand: string = 'cursor-agent';

  constructor(private readonly processManager: IProcessManager) {}

  async test(): Promise<AdapterTestResult> {
    const found = await findCommand();
    if (found) {
      this.resolvedCommand = found.command;
      if (!(await isCursorLoggedIn(found.command))) {
        return {
          ok: false,
          error: cursorLoginHint(found.command),
          errorKind: AdapterErrorKind.AUTH_FAILED,
        };
      }
      return { ok: true, version: found.version };
    }
    return {
      ok: false,
      error: 'Cursor Agent CLI not found. The headless agent CLI is required (cursor-agent or agent).',
      errorKind: AdapterErrorKind.ADAPTER_NOT_FOUND,
    };
  }

  execute(params: ExecuteParams): ExecuteHandle {
    // Cursor print mode requires the prompt as a positional argument. Unlike
    // Codex, it does not support reading the prompt from stdin.
    const fullPrompt = buildFullPrompt(params.systemPrompt, params.prompt);
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--workspace', params.workspace,
      '--yolo', // bypass interactive prompts for autonomous agents
      '--trust', // ORCH creates fresh worktrees that have not been trusted interactively
    ];

    if (params.config.model) {
      args.push('--model', params.config.model);
    }

    args.push(fullPrompt);

    const command = this.resolvedCommand.toLowerCase().endsWith('.cmd')
      ? (process.env['ComSpec'] ?? 'cmd.exe')
      : this.resolvedCommand;
    const spawnArgs = command === this.resolvedCommand
      ? args
      : ['/d', '/s', '/c', this.resolvedCommand, ...args];
    const { process: proc, pid } = this.processManager.spawn(command, spawnArgs, {
      cwd: params.workspace,
      env: { ...process.env, ...params.env },
      signal: params.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const events = createStreamingEvents(proc, parseCursorEvent, 'Cursor agent', params.signal);

    return { pid, events };
  }

  async stop(pid: number): Promise<void> {
    await this.processManager.killWithGrace(pid);
  }
}

function parseCursorEvent(line: string): AgentEvent | null {
  if (!line.trim()) return null;

  try {
    const parsed: Record<string, unknown> = JSON.parse(line);
    const timestamp = new Date().toISOString();

    // Cursor stream-json uses the same format as Claude stream-json
    switch (parsed.type) {
      case 'assistant':
        return { type: 'output', timestamp, data: (parsed.message as unknown) ?? parsed };
      case 'tool_use':
        return { type: 'tool_call', timestamp, data: parsed };
      case 'tool_result':
        return { type: 'output', timestamp, data: parsed };
      case 'error': {
        const errData = (parsed.error as unknown) ?? parsed;
        const errMsg = typeof errData === 'string' ? errData : JSON.stringify(errData);
        return { type: 'error', timestamp, data: errData, errorKind: classifyAdapterError(errMsg) };
      }
      case 'result': {
        const tokens = extractTokens(parsed);
        return { type: 'done', timestamp, data: parsed, tokens };
      }
      default:
        return { type: 'output', timestamp, data: parsed };
    }
  } catch {
    return { type: 'output', timestamp: new Date().toISOString(), data: line };
  }
}
