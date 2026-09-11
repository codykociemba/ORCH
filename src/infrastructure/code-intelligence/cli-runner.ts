/**
 * Short-lived CLI runner (analyze / status / wiki). Not the MCP graph path.
 */

import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ICliRunner } from './interface.js';

/** LadybugDB's bundled default (256 MiB) OOMs on mid-size TS repos during COPY. */
export const DEFAULT_GITNEXUS_LBUG_BUFFER_POOL_SIZE = '2147483648';

export function gitnexusCliEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (!env['GITNEXUS_LBUG_BUFFER_POOL_SIZE']) {
    env['GITNEXUS_LBUG_BUFFER_POOL_SIZE'] = DEFAULT_GITNEXUS_LBUG_BUFFER_POOL_SIZE;
  }
  if (process.platform === 'win32') {
    const gitOpenSsl = 'C:\\Program Files\\Git\\mingw64\\bin';
    if (fs.existsSync(gitOpenSsl)) {
      const pathKey = env['Path'] !== undefined ? 'Path' : 'PATH';
      const current = env[pathKey] ?? '';
      if (!current.toLowerCase().includes(gitOpenSsl.toLowerCase())) {
        env[pathKey] = `${gitOpenSsl};${current}`;
      }
    }
  }
  return env;
}

export class ExecFileCliRunner implements ICliRunner {
  run(
    command: string,
    args: string[],
    cwd?: string,
    env?: NodeJS.ProcessEnv,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const invoked = resolveGitnexusSpawn(command, args, cwd);
      execFile(
        invoked.command,
        invoked.args,
        { cwd, env: env ?? process.env, timeout: 600_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
          resolve({
            code,
            stdout: stdout?.toString() ?? '',
            stderr: stderr?.toString() ?? (error instanceof Error ? error.message : ''),
          });
        },
      );
    });
  }
}

export function gitnexusBin(): string {
  const explicit = process.env['GITNEXUS_BIN'];
  if (explicit === 'wsl' || explicit === 'wsl-gitnexus') return 'wsl-gitnexus';
  if (explicit) return explicit;
  if (detectWslGitnexus()) return 'wsl-gitnexus';
  return process.platform === 'win32' ? 'gitnexus.cmd' : 'gitnexus';
}

const LOCAL_WIKI_PROVIDERS = new Set(['claude', 'cursor', 'codex', 'opencode', 'grok']);

/** Local CLI wiki providers must see the host PATH; WSL GitNexus cannot. */
export function gitnexusBinForWiki(args: string[] = []): string {
  if (process.env['GITNEXUS_WIKI_USE_WSL'] === '1') return gitnexusBin();
  const providerIndex = args.indexOf('--provider');
  const provider = providerIndex >= 0 ? (args[providerIndex + 1] ?? '').toLowerCase() : '';
  if (process.platform === 'win32' && LOCAL_WIKI_PROVIDERS.has(provider)) {
    return 'gitnexus.cmd';
  }
  return gitnexusBin();
}

export function gitnexusJsEntry(): string | undefined {
  const candidates = [
    process.env['GITNEXUS_JS'],
    path.join(process.env['APPDATA'] ?? '', 'npm', 'node_modules', 'gitnexus', 'dist', 'cli', 'index.js'),
    path.join(process.cwd(), 'node_modules', 'gitnexus', 'dist', 'cli', 'index.js'),
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && fs.existsSync(candidate)));
}

/** Avoid spawn EINVAL on Windows npm .cmd shims (stdio MCP needs a real Node process). */
export function resolveGitnexusSpawn(
  command: string,
  args: string[],
  cwd?: string,
): { command: string; args: string[] } {
  const lower = command.toLowerCase();
  if (lower === 'wsl-gitnexus' || lower === 'wsl') {
    return wrapWslGitnexus(args, cwd);
  }
  if (process.platform !== 'win32') return { command, args };
  const looksLikeShim = lower.endsWith('.cmd') || lower.endsWith('.bat') || lower === 'gitnexus';
  if (!looksLikeShim) return { command, args };
  const js = gitnexusJsEntry();
  if (js) return { command: process.execPath, args: [js, ...args] };
  return {
    command: process.env['ComSpec'] ?? 'cmd.exe',
    args: ['/d', '/s', '/c', command, ...args],
  };
}

export function toWslPath(windowsPath: string): string {
  const normalized = windowsPath.replace(/\\/g, '/');
  const match = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (!match) return normalized;
  return `/mnt/${match[1]!.toLowerCase()}/${match[2]}`;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const WSL_GITNEXUS_PREFIX = [
  'u=$(id -un)',
  'export HOME=/home/$u',
  'export NVM_DIR=$HOME/.nvm',
  '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
  `export GITNEXUS_LBUG_BUFFER_POOL_SIZE="\${GITNEXUS_LBUG_BUFFER_POOL_SIZE:-${DEFAULT_GITNEXUS_LBUG_BUFFER_POOL_SIZE}}"`,
].join('; ');

export function wrapWslGitnexus(args: string[], cwd?: string): { command: string; args: string[] } {
  const cd = cwd ? `cd ${shQuote(toWslPath(cwd))} && ` : '';
  const inner = args.map(shQuote).join(' ');
  return {
    command: 'wsl.exe',
    args: ['-e', '/bin/bash', '-lc', `${WSL_GITNEXUS_PREFIX}; ${cd}exec gitnexus ${inner}`],
  };
}

let wslGitnexusCached: boolean | undefined;

export function resetWslGitnexusCache(): void {
  wslGitnexusCached = undefined;
}

/** True when native Windows should drive GitNexus through WSL2 (supported runtime). */
export function detectWslGitnexus(): boolean {
  if (wslGitnexusCached !== undefined) return wslGitnexusCached;
  if (process.platform !== 'win32') return wslGitnexusCached = false;
  if (process.env['GITNEXUS_USE_WSL'] === '0') return wslGitnexusCached = false;
  if (process.env['WSL_DISTRO_NAME']) return wslGitnexusCached = false;
  if (process.env['GITNEXUS_USE_WSL'] === '1' || process.env['GITNEXUS_BIN'] === 'wsl') {
    return wslGitnexusCached = true;
  }
  try {
    const result = execFileSync(
      'wsl.exe',
      ['-e', '/bin/bash', '-lc', `${WSL_GITNEXUS_PREFIX}; command -v gitnexus`],
      { timeout: 8_000, windowsHide: true, encoding: 'utf8' },
    );
    return wslGitnexusCached = /gitnexus/.test(result);
  } catch {
    return wslGitnexusCached = false;
  }
}
