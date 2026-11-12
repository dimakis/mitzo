import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  buildPermissionHandler,
  effectivePermissionMode,
  type ManagedSession,
  type SessionRegistry,
} from '@mitzo/harness';

/**
 * Shell `gws` for agent sandboxes. The sandbox never sees Google credentials:
 * a small client on disk forwards argv over a per-chat Unix socket, and Mitzo
 * runs the operator's host `gws` after the chat's approval rule:
 * Auto runs freely; elsewhere reads can be allowed once per chat and every
 * change needs its own approval. File arguments are staged by the client inside
 * the sandbox, so host gws never reads or writes caller-chosen host paths.
 */

const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const RUN_TIMEOUT_MS = 120_000;

export function gwsBrokerRoot(): string {
  return process.env.MITZO_GWS_BROKER_DIR || join(homedir(), '.local', 'state', 'mitzo-gws');
}
/** Stable absolute client path; login shells reorder PATH, so agents call it by path. */
export function gwsShimPath(): string {
  return join(gwsBrokerRoot(), 'bin', 'gws');
}

const READ_METHODS = new Set(['get', 'list', 'export', 'batchGet', 'search', 'query']);
const READ_HELPERS = new Set([
  '+read',
  '+triage',
  '+agenda',
  '+standup-report',
  '+meeting-prep',
  '+weekly-digest',
]);

/** Reads are provable single reads; everything else (including unknown shapes) is a change. */
export function classifyGwsArgv(argv: readonly string[]): 'read' | 'write' {
  if (argv.some((arg) => arg === '--help' || arg === '-h' || arg === '--dry-run')) return 'read';
  const positionals: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith('-')) break;
    positionals.push(arg);
  }
  if (positionals[0] === 'schema') return 'read';
  const last = positionals.at(-1);
  if (last && READ_HELPERS.has(last) && positionals.length === 2) return 'read';
  return positionals.length >= 3 &&
    positionals.every((part) => /^[A-Za-z][A-Za-z0-9]*$/.test(part)) &&
    READ_METHODS.has(last!)
    ? 'read'
    : 'write';
}

/** Shell-quote for the approval card; display only. */
function displayCommand(argv: readonly string[]) {
  return ['gws', ...argv]
    .map((arg) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`))
    .join(' ');
}

/**
 * True for a single plain invocation of the Mitzo gws client (optionally inside
 * a `sh|bash|zsh -c|-lc` wrapper). Such commands only reach the broker, which
 * owns the Google approval, so the shell layer need not prompt as well.
 */
export function isGwsShimCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false;
  let text = command.trim();
  const wrapped = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(text);
  if (wrapped) text = wrapped[2]!.trim();
  const shim = gwsShimPath();
  if (text !== shim && !text.startsWith(shim + ' ')) return false;
  // Quoted arguments (JSON, message text) are opaque values, not shell syntax.
  const unquoted = text.replace(/'[^']*'|"(?:[^"\\$`]|\\.)*"/g, ' Q ');
  return !/[;&|<>`$()\n\\'"*?[\]{}~]/.test(unquoted);
}

/** Client program. Plain Node, no dependencies; runs inside agent sandboxes. */
function shimProgram(node: string) {
  return `#!${node}
'use strict';
// Mitzo gws client: forwards to the chat's broker; credentials stay with Mitzo.
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const socket = process.env.MITZO_GWS_SOCKET;
if (!socket) {
  process.stderr.write('gws: the Mitzo gws broker is not available in this shell.\\n');
  process.exit(2);
}
const IN = new Set(['--upload', '--attach', '-a']);
const OUT = new Set(['--output', '-o']);
const VALUE = new Set(['--parent', '--name', '--format', '--sanitize', '--upload-content-type']);
const argv = process.argv.slice(2);
const files = [];
const outputs = [];
function stage(index, value, prefix) {
  const file = path.resolve(value);
  files.push({ index, prefix, name: path.basename(file), data: fs.readFileSync(file).toString('base64') });
}
let uploadHelper = false;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  const eq = arg.indexOf('=');
  const flag = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
  const inline = flag !== arg ? arg.slice(eq + 1) : undefined;
  if (arg === '--output-dir' || flag === '--output-dir') {
    process.stderr.write('gws: --output-dir is unavailable through Mitzo; use --output or stdout.\\n');
    process.exit(2);
  }
  if (IN.has(flag) || OUT.has(flag)) {
    const index = inline === undefined ? ++i : i;
    const value = inline === undefined ? argv[index] : inline;
    if (value === undefined) break;
    if (IN.has(flag)) stage(index, value, inline === undefined ? '' : flag + '=');
    else outputs.push({ index, prefix: inline === undefined ? '' : flag + '=', path: path.resolve(value) });
    continue;
  }
  if (arg === '+upload') { uploadHelper = true; continue; }
  if (VALUE.has(arg)) { i++; continue; }
  if (uploadHelper && !arg.startsWith('-')) { stage(i, arg, ''); uploadHelper = false; }
}
const client = net.createConnection(socket);
const chunks = [];
client.on('data', (chunk) => chunks.push(chunk));
client.on('error', (error) => {
  process.stderr.write('gws: cannot reach the Mitzo gws broker (' + error.code + ').' +
    (error.code === 'EPERM' ? ' Request network permission for this exact command and retry.' : '') + '\\n');
  process.exit(2);
});
client.on('end', () => {
  let reply;
  try { reply = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    process.stderr.write('gws: invalid broker reply.\\n');
    process.exit(2);
  }
  for (const out of reply.outputs || []) {
    const target = outputs.find((entry) => entry.index === out.index);
    if (target) fs.writeFileSync(target.path, Buffer.from(out.data, 'base64'));
  }
  if (reply.stdout) process.stdout.write(reply.stdout);
  if (reply.stderr) process.stderr.write(reply.stderr);
  process.exitCode = typeof reply.exitCode === 'number' ? reply.exitCode : 1;
});
client.end(JSON.stringify({ v: 1, argv, files, outputs: outputs.map(({ index, prefix }) => ({ index, prefix })) }));
`;
}

let installedShim: string | undefined;
/** Writes the client only when its content differs; the directory stays owner-only. */
export function installGwsShim(): string {
  const path = gwsShimPath();
  const program = shimProgram(process.execPath);
  if (installedShim === program && existsSync(path)) return path;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let current: string | undefined;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    current = undefined;
  }
  if (current !== program) writeFileSync(path, program, { mode: 0o755 });
  chmodSync(path, 0o755);
  installedShim = program;
  return path;
}

function hostGwsBinary(): string | undefined {
  const shimDir = dirname(gwsShimPath());
  for (const dir of [
    ...(process.env.PATH ?? '').split(delimiter),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ]) {
    if (!dir || !isAbsolute(dir) || dir === shimDir) continue;
    const candidate = join(dir, 'gws');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

interface BrokerRequest {
  v: 1;
  argv: string[];
  files: { index: number; prefix: string; name: string; data: string }[];
  outputs: { index: number; prefix: string }[];
}
interface BrokerReply {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  outputs?: { index: number; data: string }[];
}

function parseRequest(raw: string): BrokerRequest {
  const value = JSON.parse(raw) as BrokerRequest;
  const index = (n: unknown, length: number) =>
    Number.isInteger(n) && (n as number) >= 0 && (n as number) < length;
  if (
    value?.v !== 1 ||
    !Array.isArray(value.argv) ||
    value.argv.length > 256 ||
    !value.argv.every((arg) => typeof arg === 'string' && !arg.includes('\0')) ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.outputs) ||
    ![...value.files, ...value.outputs].every(
      (entry) =>
        index(entry?.index, value.argv.length) &&
        ['', '--upload=', '--attach=', '--output='].includes(entry.prefix),
    ) ||
    !value.files.every((file) => typeof file.name === 'string' && typeof file.data === 'string')
  )
    throw Error('Invalid gws request');
  return value;
}

const refuse = (message: string): BrokerReply => ({ exitCode: 2, stderr: `gws: ${message}\n` });

/** Rejects host path arguments the client did not stage. */
function hostPathArgument(arg: string, scratch: string): boolean {
  const value = arg.replace(/^--[a-z-]+=/, '').replace(/^@/, '');
  if (!value || value.startsWith('{') || value.startsWith('[')) return false;
  const expanded =
    value === '~' || value.startsWith('~/') ? join(homedir(), value.slice(1)) : value;
  if (!isAbsolute(expanded) && !value.includes('/')) return false;
  const full = resolve(scratch, expanded);
  const inside = relative(scratch, full);
  if (inside && !inside.startsWith('..') && !isAbsolute(inside)) return false;
  return existsSync(full);
}

export interface GwsBrokerOwner {
  /** Stable chat key; also scopes the read grant. */
  readonly key: string;
  readonly registry: SessionRegistry;
  /** Live owner of the chat, resolved on every request. */
  resolve(): { clientId: string; session: ManagedSession } | null;
}

export interface GwsBroker {
  readonly socketPath: string;
  readonly shimPath: string;
  /** Environment for the agent's shell. */
  env(): Record<string, string>;
  close(): void;
}

const brokers = new Map<
  string,
  { broker: GwsBroker; registry: SessionRegistry; owner: GwsBrokerOwner }
>();

export function gwsReadSessionGrantKey(key: string): string {
  return `gws-read-v1:${createHash('sha256')
    .update(JSON.stringify([key, hostGwsBinary() ?? null]))
    .digest('hex')}`;
}

async function authorize(
  owner: GwsBrokerOwner,
  argv: readonly string[],
  signal: AbortSignal,
): Promise<string | undefined> {
  const found = owner.resolve();
  if (!found || found.session.abortController.signal.aborted)
    return 'this chat is no longer active.';
  const mode = effectivePermissionMode(found.session);
  if (mode === 'auto') return;
  const kind = classifyGwsArgv(argv);
  const command = displayCommand(argv);
  const permission = await buildPermissionHandler(found.clientId, owner.registry)(
    'Bash',
    { command },
    {
      signal,
      toolUseID: randomUUID(),
      forcePrompt: true,
      ...(kind === 'read'
        ? {
            title: 'Read Google Workspace with gws',
            allowSessionGrant: true,
            approvalScope: 'session' as const,
            sessionGrantKey: gwsReadSessionGrantKey(owner.key),
            sessionGrantDescription:
              'Allow for session covers gws reads (get, list, export, search) in this chat. gws changes still need approval each time.',
            description: `${command}\nRuns with your signed-in Google account. Credentials remain private to Mitzo.`,
          }
        : {
            title: 'Change Google Workspace with gws',
            allowSessionGrant: false,
            rememberSessionGrant: false,
            approvalScope: 'request' as const,
            description: `${command}\nRuns with your signed-in Google account and may create, change, send or delete Google data.`,
          }),
    },
  );
  if (permission.behavior !== 'allow') return permission.message || 'not approved.';
  const after = owner.resolve();
  if (!after || after.session !== found.session) return 'this chat changed during approval.';
  if (effectivePermissionMode(after.session) === 'ask' && kind === 'write')
    return 'this chat is in Ask mode.';
  return;
}

async function run(owner: GwsBrokerOwner, request: BrokerRequest): Promise<BrokerReply> {
  const argv = [...request.argv];
  if (argv[0] === 'auth' || argv[0] === 'config')
    return refuse(`'${argv[0]}' is not available to agents; sign in on the Mac with gws directly.`);
  const binary = hostGwsBinary();
  if (!binary) return refuse('gws is not installed on this Mac.');
  const scratch = await mkdtemp(join(tmpdir(), 'mitzo-gws-'));
  const signal = AbortSignal.timeout(10 * 60_000);
  try {
    for (const [n, file] of request.files.entries()) {
      const name = `in-${n}-${basename(file.name).replace(/[^\w.-]/g, '_') || 'file'}`;
      await writeFile(join(scratch, name), Buffer.from(file.data, 'base64'));
      argv[file.index] = file.prefix + join(scratch, name);
    }
    for (const out of request.outputs)
      argv[out.index] = out.prefix + join(scratch, `out-${out.index}`);
    const staged = new Set([...request.files, ...request.outputs].map((entry) => entry.index));
    if (argv.some((arg, i) => !staged.has(i) && hostPathArgument(arg, scratch)))
      return refuse(
        'host file paths are unavailable; pass files with --upload, --attach or --output.',
      );
    const refusal = await authorize(owner, request.argv, signal);
    if (refusal) return refuse(refusal);
    const result = await new Promise<BrokerReply>((resolveRun) => {
      execFile(
        binary,
        argv,
        {
          cwd: scratch,
          timeout: RUN_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          env: { ...process.env, GOOGLE_WORKSPACE_CLI_LOG_FILE: '' },
        },
        (error, stdout, stderr) =>
          resolveRun({
            exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
            stdout,
            stderr: error && !stderr ? `gws: ${error.killed ? 'timed out' : 'failed'}\n` : stderr,
          }),
      );
    });
    const outputs: { index: number; data: string }[] = [];
    for (const out of request.outputs) {
      const path = join(scratch, `out-${out.index}`);
      const info = await stat(path).catch(() => undefined);
      if (!info?.isFile()) continue;
      if (info.size > MAX_OUTPUT_BYTES) return refuse('output file is too large.');
      outputs.push({ index: out.index, data: (await readFile(path)).toString('base64') });
    }
    return { ...result, outputs };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function socketPathFor(key: string) {
  const id = createHash('sha256').update(key).digest('hex').slice(0, 16);
  return join(gwsBrokerRoot(), 's', `${id}.sock`);
}

function prepareSocketDirectory(path: string) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.uid !== process.getuid?.())
    throw Error('Unsafe gws broker directory');
  chmodSync(dir, 0o700);
  try {
    unlinkSync(path);
  } catch {
    // absent
  }
}

/** One broker per chat; the registry decides the live owner on every request. */
export function gwsBrokerForSession(owner: GwsBrokerOwner): GwsBroker {
  const existing = brokers.get(owner.key);
  if (existing?.registry === owner.registry) {
    existing.owner = owner;
    return existing.broker;
  }
  existing?.broker.close();
  const shimPath = installGwsShim();
  const socketPath = socketPathFor(owner.key);
  prepareSocketDirectory(socketPath);
  let active = 0;
  const server: Server = createServer({ allowHalfOpen: true }, (connection) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const reply = (value: BrokerReply) => connection.end(JSON.stringify(value));
    connection.on('error', () => connection.destroy());
    connection.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        reply(refuse('request is too large.'));
        connection.destroy();
      } else chunks.push(chunk);
    });
    connection.on('end', () => {
      if (size > MAX_REQUEST_BYTES) return;
      if (active >= 4) return reply(refuse('too many gws commands at once; retry.'));
      active++;
      let request: BrokerRequest;
      try {
        request = parseRequest(Buffer.concat(chunks).toString('utf8'));
      } catch {
        active--;
        return reply(refuse('invalid request.'));
      }
      run(brokers.get(owner.key)?.owner ?? owner, request)
        .catch(() => refuse('the command could not run.'))
        .then(reply)
        .finally(() => active--);
    });
  });
  server.listen(socketPath);
  server.unref();
  const broker: GwsBroker = {
    socketPath,
    shimPath,
    env: () => ({ MITZO_GWS_SOCKET: socketPath, MITZO_GWS: shimPath }),
    close: () => {
      if (brokers.get(owner.key)?.broker === broker) brokers.delete(owner.key);
      server.close();
      try {
        unlinkSync(socketPath);
      } catch {
        // already removed
      }
    },
  };
  brokers.set(owner.key, { broker, registry: owner.registry, owner });
  return broker;
}

/** Agent guidance shared by every runtime. */
export function gwsShellGuidance(): string {
  const shim = gwsShimPath();
  return `Google Workspace: run the gws CLI as ${shim} with normal gws arguments (for example ${shim} docs documents create --json '{"title":"Notes"}'). Plain \`gws\` cannot reach the signed-in account from this shell. It covers Docs, Sheets, Slides, Drive, Gmail, Calendar, Tasks and the gws helpers. Pass local files with --upload, --attach or --output; other host paths are refused. Reads may be approved once per chat; every change asks for approval unless the chat is in Auto. In Agent or Ask on native Codex, request network permission for the exact ${shim} command; Mitzo accepts that automatically and asks about the Google action itself. Never print or copy credentials, and do not run gws auth.`;
}
