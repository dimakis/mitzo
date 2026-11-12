import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * Dependency-free shell gws helpers shared by sandboxes, executors and the
 * broker. Keep this module free of server imports: sandboxed-command and the
 * native executor load it, and the broker's authority checks must not create
 * an import cycle back into them.
 */

export function gwsBrokerRoot(): string {
  const configured = process.env.MITZO_GWS_BROKER_DIR;
  return configured && isAbsolute(configured)
    ? configured
    : join(homedir(), '.local', 'state', 'mitzo-gws');
}
/** Stable absolute client path; login shells reorder PATH, so agents call it by path. */
export function gwsShimPath(): string {
  return join(gwsBrokerRoot(), 'bin', 'gws');
}

const OUTPUT_FLAGS = new Set(['--output', '-o']);

/**
 * Strict POSIX word split for literal commands only. Single quotes are literal;
 * double quotes allow only \\ \" escapes and refuse $ and backticks; unquoted
 * text is limited to inert characters. Anything a shell could expand, redirect
 * or chain returns undefined.
 */
export function literalShellWords(text: string): string[] | undefined {
  const words: string[] = [];
  let word: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === ' ' || char === '\t') {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else if (char === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return;
      word = (word ?? '') + text.slice(i + 1, end);
      i = end;
    } else if (char === '"') {
      let value = '';
      let closed = false;
      for (i++; i < text.length; i++) {
        const inner = text[i]!;
        if (inner === '"') {
          closed = true;
          break;
        }
        if (inner === '$' || inner === '`') return;
        if (inner === '\\') {
          const escaped = text[++i];
          if (escaped !== '\\' && escaped !== '"') return;
          value += escaped;
        } else value += inner;
      }
      if (!closed) return;
      word = (word ?? '') + value;
    } else if (/[A-Za-z0-9_@%+=:,./-]/.test(char)) word = (word ?? '') + char;
    else return;
  }
  if (word !== undefined) words.push(word);
  return words;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', '/bin/sh', '/bin/bash', '/bin/zsh', '/usr/bin/env']);

/**
 * Arguments of a single literal invocation of the Mitzo gws client, optionally
 * inside one `sh|bash|zsh -c|-lc '<literal>'` envelope; otherwise undefined.
 * Such commands only reach the broker, which owns the Google approval.
 */
export function gwsShimInvocation(command: unknown): string[] | undefined {
  if (typeof command !== 'string' || /[\r\n\0]/.test(command)) return;
  let words = literalShellWords(command.trim());
  if (
    words?.length === 3 &&
    SHELLS.has(words[0]!) &&
    words[0] !== '/usr/bin/env' &&
    (words[1] === '-c' || words[1] === '-lc')
  )
    words = literalShellWords(words[2]!.trim());
  if (!words?.length || words[0] !== gwsShimPath()) return;
  return words.slice(1);
}
export function isGwsShimCommand(command: unknown): boolean {
  return gwsShimInvocation(command) !== undefined;
}
/** True when the client would write local files (only --output does). */
export function gwsShimWritesFiles(argv: readonly string[]): boolean {
  return argv.some(
    (arg) =>
      OUTPUT_FLAGS.has(arg) || arg.startsWith('--output') || (arg.startsWith('-o') && arg !== '-o'),
  );
}

/** Environment variables the broker adds to a chat's shell. */
export const GWS_SHELL_ENV_NAMES = Object.freeze([
  'MITZO_GWS_SOCKET',
  'MITZO_GWS_TOKEN',
  'MITZO_GWS',
]);

/** Agent guidance shared by every runtime. */
export function gwsShellGuidance(): string {
  const shim = gwsShimPath();
  return `Google Workspace: run the gws CLI as ${shim} with normal gws arguments (for example ${shim} docs documents create --json '{"title":"Notes"}'). Plain \`gws\` cannot reach the signed-in account from this shell. It covers Docs, Sheets, Slides, Drive, Gmail, Calendar, Tasks and the gws helpers. Run it as one plain command without pipes, substitutions or variables. Pass local files with --upload, --attach or --output; other host paths are refused. Reads may be approved once per chat; every change asks for approval unless the chat is in Auto, and changes are unavailable in Ask. In Agent or Ask on native Codex, request network permission for the exact ${shim} command; Mitzo accepts that automatically and asks about the Google action itself. Never print or copy credentials or MITZO_GWS_TOKEN, and do not run gws auth.`;
}
