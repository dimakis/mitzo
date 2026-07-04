/** Terminal Manager — PTY lifecycle for interactive shell terminals. */

import * as pty from 'node-pty';
import { randomUUID } from 'crypto';
import { createLogger } from './logger.js';

const log = createLogger('terminal');

export interface TerminalInfo {
  id: string;
  sessionId: string;
  pid: number;
  cols: number;
  rows: number;
  cwd: string;
  createdAt: number;
}

interface ManagedTerminal {
  id: string;
  sessionId: string;
  connectionId: string;
  process: pty.IPty;
  cols: number;
  rows: number;
  cwd: string;
  createdAt: number;
  /** Callback to send output data to the client. */
  onData: ((data: string) => void) | null;
  /** Callback when the terminal process exits. */
  onExit: ((exitCode: number, signal?: number) => void) | null;
}

/** Safe env vars to inherit — everything else is stripped. */
const SAFE_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'TERM',
  'COLORTERM',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'TMPDIR',
  'TZ',
]);
const SAFE_ENV_PREFIXES = ['LC_', 'XDG_'];

const MAX_TERMINALS_PER_SESSION = 5;
const MAX_TERMINALS_GLOBAL = 50;

/** Active terminals keyed by terminal ID. */
const terminals = new Map<string, ManagedTerminal>();

function generateTerminalId(): string {
  return `term-${randomUUID()}`;
}

function getDefaultShell(): string {
  return process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/sh');
}

function buildSafeEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (val == null) continue;
    if (SAFE_ENV_KEYS.has(key) || SAFE_ENV_PREFIXES.some((p) => key.startsWith(p))) {
      env[key] = val;
    }
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  if (extra) Object.assign(env, extra);
  return env;
}

export interface CreateTerminalOpts {
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  onData?: (data: string) => void;
  onExit?: (exitCode: number, signal?: number) => void;
}

export function createTerminal(
  sessionId: string,
  connectionId: string,
  cwd: string,
  opts?: CreateTerminalOpts,
): TerminalInfo {
  if (terminals.size >= MAX_TERMINALS_GLOBAL) {
    throw new Error(`Global terminal limit reached (${MAX_TERMINALS_GLOBAL})`);
  }
  const sessionCount = [...terminals.values()].filter((t) => t.sessionId === sessionId).length;
  if (sessionCount >= MAX_TERMINALS_PER_SESSION) {
    throw new Error(`Session terminal limit reached (${MAX_TERMINALS_PER_SESSION})`);
  }

  const id = generateTerminalId();
  const cols = opts?.cols ?? 80;
  const rows = opts?.rows ?? 24;
  const shell = getDefaultShell();

  const managed: ManagedTerminal = {
    id,
    sessionId,
    connectionId,
    process: null!,
    cols,
    rows,
    cwd,
    createdAt: Date.now(),
    onData: opts?.onData ?? null,
    onExit: opts?.onExit ?? null,
  };

  // Wire callbacks BEFORE spawning so no output is dropped
  const proc = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: buildSafeEnv(opts?.env),
  });
  managed.process = proc;

  proc.onData((data) => {
    managed.onData?.(data);
  });

  proc.onExit(({ exitCode, signal }) => {
    log.info('terminal exited', { id, sessionId, exitCode, signal });
    managed.onExit?.(exitCode, signal);
    terminals.delete(id);
  });

  terminals.set(id, managed);
  log.info('terminal created', { id, sessionId, cwd, shell, pid: proc.pid });

  return { id, sessionId, pid: proc.pid, cols, rows, cwd, createdAt: managed.createdAt };
}

export function writeTerminal(id: string, data: string): boolean {
  const term = terminals.get(id);
  if (!term) return false;
  term.process.write(data);
  return true;
}

export function resizeTerminal(id: string, cols: number, rows: number): boolean {
  const term = terminals.get(id);
  if (!term) return false;
  term.process.resize(cols, rows);
  term.cols = cols;
  term.rows = rows;
  return true;
}

export function destroyTerminal(id: string): boolean {
  const term = terminals.get(id);
  if (!term) return false;
  try {
    term.process.kill();
  } catch (err) {
    log.warn('kill failed (process may have already exited)', { id, error: String(err) });
  }
  terminals.delete(id);
  log.info('terminal destroyed', { id, sessionId: term.sessionId });
  return true;
}

export function getTerminal(id: string): TerminalInfo | null {
  const term = terminals.get(id);
  if (!term) return null;
  return {
    id: term.id,
    sessionId: term.sessionId,
    pid: term.process.pid,
    cols: term.cols,
    rows: term.rows,
    cwd: term.cwd,
    createdAt: term.createdAt,
  };
}

export function listTerminals(sessionId?: string): TerminalInfo[] {
  const result: TerminalInfo[] = [];
  for (const term of terminals.values()) {
    if (sessionId && term.sessionId !== sessionId) continue;
    result.push({
      id: term.id,
      sessionId: term.sessionId,
      pid: term.process.pid,
      cols: term.cols,
      rows: term.rows,
      cwd: term.cwd,
      createdAt: term.createdAt,
    });
  }
  return result;
}

export function destroySessionTerminals(sessionId: string): number {
  let count = 0;
  for (const [id, term] of terminals.entries()) {
    if (term.sessionId === sessionId) {
      try {
        term.process.kill();
      } catch (err) {
        log.warn('kill failed during session cleanup', { id, error: String(err) });
      }
      terminals.delete(id);
      count++;
    }
  }
  if (count > 0) {
    log.info('destroyed session terminals', { sessionId, count });
  }
  return count;
}

export function destroyConnectionTerminals(connectionId: string): number {
  let count = 0;
  for (const [id, term] of terminals.entries()) {
    if (term.connectionId === connectionId) {
      try {
        term.process.kill();
      } catch (err) {
        log.warn('kill failed during connection cleanup', { id, error: String(err) });
      }
      terminals.delete(id);
      count++;
    }
  }
  if (count > 0) {
    log.info('destroyed connection terminals', { connectionId, count });
  }
  return count;
}

export function getTerminalOwner(id: string): string | null {
  return terminals.get(id)?.connectionId ?? null;
}

export function setTerminalCallbacks(
  id: string,
  onData: (data: string) => void,
  onExit: (exitCode: number, signal?: number) => void,
): boolean {
  const term = terminals.get(id);
  if (!term) return false;
  term.onData = onData;
  term.onExit = onExit;
  return true;
}

export function clearTerminalCallbacks(id: string): boolean {
  const term = terminals.get(id);
  if (!term) return false;
  term.onData = null;
  term.onExit = null;
  return true;
}
