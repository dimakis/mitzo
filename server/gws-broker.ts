import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
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
  checkSkillPolicy,
  effectivePermissionMode,
  type ManagedSession,
  type SessionRegistry,
} from '@mitzo/harness';
import { agentToolAllowed } from './agent-tool-selection.js';
import { gwsBrokerRoot, gwsFileArguments, gwsShimPath } from './gws-shell.js';
export {
  GWS_SHELL_ENV_NAMES,
  gwsBrokerRoot,
  gwsShellGuidance,
  gwsShimInvocation,
  gwsShimPath,
  gwsShimWritesFiles,
  isGwsShimCommand,
  literalShellWords,
} from './gws-shell.js';
import { createLogger } from './logger.js';

/**
 * Shell `gws` for agent sandboxes. The sandbox never sees Google credentials:
 * a small client on disk forwards argv over a per-chat Unix socket, and Mitzo
 * runs the operator's host `gws` after the chat's approval rule:
 * Auto runs freely; elsewhere reads can be allowed once per chat and every
 * change needs its own approval (refused in Ask). File arguments are staged by
 * the client inside the sandbox, so host gws never reads or writes caller-chosen
 * host paths. Same-UID sandboxes can see every socket, so each request must
 * carry its chat's secret token; the socket path alone grants nothing.
 */

const log = createLogger('gws-broker');
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const RUN_TIMEOUT_MS = 120_000;
const MAX_CONCURRENT = 4;

const READ_METHODS = new Set(['get', 'list', 'export', 'batchGet', 'search', 'query']);
const READ_HELPERS = new Set([
  '+read',
  '+triage',
  '+agenda',
  '+standup-report',
  '+meeting-prep',
  '+weekly-digest',
]);

/**
 * Reads are provable single reads by command shape; everything else (helpers
 * with side effects, unknown shapes, flags such as --dry-run that a helper may
 * ignore) is a change. Classify the arguments that will actually execute.
 */
export function classifyGwsArgv(argv: readonly string[]): 'read' | 'write' {
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

/** Client program. Plain Node, no dependencies; runs inside agent sandboxes. */
function shimProgram(node: string) {
  return `#!${node}
'use strict';
// Mitzo gws client: forwards to the chat's broker; credentials stay with Mitzo.
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const socket = process.env.MITZO_GWS_SOCKET;
const token = process.env.MITZO_GWS_TOKEN;
if (!socket || !token) {
  process.stderr.write('gws: the Mitzo gws broker is not available in this shell.\\n');
  process.exit(2);
}
const gwsFileArguments = ${gwsFileArguments.toString()};
const argv = process.argv.slice(2);
const files = [];
const outputs = [];
function fail(message) {
  process.stderr.write('gws: ' + message + '\\n');
  process.exit(2);
}
function stage(index, value, prefix) {
  const file = path.resolve(value);
  files.push({ index, prefix, name: path.basename(file), data: fs.readFileSync(file).toString('base64') });
}
const parsed = gwsFileArguments(argv);
if (parsed.error) fail(parsed.error);
for (const entry of parsed.entries) {
  if (entry.kind === 'in') stage(entry.index, entry.value, entry.prefix);
  else outputs.push({ index: entry.index, prefix: entry.prefix, path: path.resolve(entry.value) });
}
const client = net.createConnection(socket);
const chunks = [];
client.on('data', (chunk) => chunks.push(chunk));
client.on('error', (error) => {
  fail('cannot reach the Mitzo gws broker (' + error.code + ').' +
    (error.code === 'EPERM' ? ' Request network permission for this exact command and retry.' : ''));
});
client.on('end', () => {
  let reply;
  try { reply = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('invalid broker reply.'); }
  for (const out of reply.outputs || []) {
    const target = outputs.find((entry) => entry.index === out.index);
    if (target) fs.writeFileSync(target.path, Buffer.from(out.data, 'base64'));
  }
  if (reply.stdout) process.stdout.write(reply.stdout);
  if (reply.stderr) process.stderr.write(reply.stderr);
  process.exitCode = typeof reply.exitCode === 'number' ? reply.exitCode : 1;
});
process.on('SIGINT', () => { client.destroy(); process.exit(130); });
process.on('SIGTERM', () => { client.destroy(); process.exit(143); });
// One newline-terminated request; the connection stays open so the broker
// cancels the host command if this client exits.
client.write(JSON.stringify({ v: 1, token, argv, files, outputs: outputs.map(({ index, prefix }) => ({ index, prefix })) }) + '\\n');
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

interface StagedEntry {
  index: number;
  prefix: string;
}
interface BrokerRequest {
  v: 1;
  token: string;
  argv: string[];
  files: (StagedEntry & { name: string; data: string })[];
  outputs: StagedEntry[];
}
interface BrokerReply {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  outputs?: { index: number; data: string }[];
}

function parseRequest(raw: string): BrokerRequest {
  const value = JSON.parse(raw) as BrokerRequest;
  if (
    value?.v !== 1 ||
    typeof value.token !== 'string' ||
    !Array.isArray(value.argv) ||
    value.argv.length > 256 ||
    !value.argv.every((arg) => typeof arg === 'string' && !arg.includes('\0')) ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.outputs) ||
    !value.files.every((file) => typeof file?.name === 'string' && typeof file.data === 'string')
  )
    throw Error('Invalid gws request');
  return value;
}

/**
 * The broker re-parses every file argument itself. Each one must be staged by
 * the client at exactly that position and prefix, and nothing else may be.
 */
function stagingValid(request: BrokerRequest): boolean {
  const parsed = gwsFileArguments(request.argv);
  if (parsed.error) return false;
  const key = (entry: { index: number; prefix: string }, kind: string) =>
    `${kind}:${entry.index}:${entry.prefix}`;
  const expected = parsed.entries.map((entry) => key(entry, entry.kind)).sort();
  const staged = [
    ...request.files.map((entry) => key(entry, 'in')),
    ...request.outputs.map((entry) => key(entry, 'out')),
  ].sort();
  return expected.length === staged.length && expected.every((entry, i) => entry === staged[i]);
}

const refuse = (message: string): BrokerReply => ({ exitCode: 2, stderr: `gws: ${message}\n` });

/** Rejects host path arguments the client did not stage. */
function hostPathArgument(arg: string, scratch: string): boolean {
  // Strip flag forms (--flag=, attached short options) before checking paths.
  const value = arg
    .replace(/^--[a-z-]+=/, '')
    .replace(/^-[A-Za-z](?=[/~.])/, '')
    .replace(/^@/, '');
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
  /** The owning runtime's own authorization fence (workspace, account, context). */
  assertCurrent?(signal: AbortSignal): Promise<void>;
  /** The chat's lifetime; the broker closes and cancels its commands when it ends. */
  readonly lifetime: AbortSignal;
}

export interface GwsBroker {
  readonly socketPath: string;
  readonly shimPath: string;
  /** Environment for this chat's shell only; the token authenticates the chat. */
  env(): Record<string, string>;
  close(): void;
}

export function gwsReadSessionGrantKey(key: string): string {
  return `gws-read-v1:${createHash('sha256')
    .update(JSON.stringify([key, hostGwsBinary() ?? null]))
    .digest('hex')}`;
}

type Authority = () => string | undefined;

/** Decide consent and return a check that the same authority still holds. */
async function authorize(
  owner: GwsBrokerOwner,
  argv: readonly string[],
  signal: AbortSignal,
): Promise<{ refusal: string } | { current: Authority }> {
  const found = owner.resolve();
  if (!found || found.session.abortController.signal.aborted)
    return { refusal: 'this chat is no longer active.' };
  const { clientId, session } = found;
  const kind = classifyGwsArgv(argv);
  const grantKey = gwsReadSessionGrantKey(owner.key);
  const base = () => {
    const now = owner.resolve();
    if (!now || now.session !== session || session.abortController.signal.aborted)
      return 'this chat changed.';
    // The shell tool ceiling applies in every mode, including Auto.
    if (
      !agentToolAllowed(session, 'Bash') ||
      checkSkillPolicy(owner.registry, now.clientId, 'Bash') === 'deny'
    )
      return 'shell commands are not allowed for this chat or skill.';
    if (kind === 'write' && effectivePermissionMode(session) === 'ask')
      return 'Google changes are unavailable in Ask mode. Switch to Agent or Auto.';
    return undefined;
  };
  const initial = base();
  if (initial) return { refusal: initial };
  if (effectivePermissionMode(session) === 'auto')
    return {
      current: () =>
        base() ??
        (effectivePermissionMode(session) === 'auto' ? undefined : 'this chat left Auto mode.'),
    };
  const command = displayCommand(argv);
  const permission = await buildPermissionHandler(clientId, owner.registry)(
    kind === 'read' ? 'GwsRead' : 'Bash',
    { command },
    {
      signal,
      toolUseID: randomUUID(),
      forcePrompt: true,
      ...(kind === 'read'
        ? {
            title: 'Read Google Workspace with gws',
            // The Bash ceiling above is the skill boundary for broker reads.
            controlPlane: true,
            allowSessionGrant: true,
            approvalScope: 'session' as const,
            sessionGrantKey: grantKey,
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
  if (permission.behavior !== 'allow') return { refusal: permission.message || 'not approved.' };
  const grantBacked = kind === 'read' && session.sessionAllowList.has(grantKey);
  const current: Authority = () =>
    base() ??
    (grantBacked && !session.sessionAllowList.has(grantKey)
      ? 'the gws read permission was removed.'
      : undefined);
  const after = current();
  return after ? { refusal: after } : { current };
}

async function run(
  owner: GwsBrokerOwner,
  request: BrokerRequest,
  signal: AbortSignal,
): Promise<BrokerReply> {
  if (!stagingValid(request)) return refuse('invalid file arguments.');
  const argv = [...request.argv];
  if (argv[0] === 'auth' || argv[0] === 'config')
    return refuse(`'${argv[0]}' is not available to agents; sign in on the Mac with gws directly.`);
  const binary = hostGwsBinary();
  if (!binary) return refuse('gws is not installed on this Mac.');
  const scratch = await mkdtemp(join(tmpdir(), 'mitzo-gws-'));
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
    // Classify and approve exactly the arguments that will execute.
    const runtimeCurrent = async () => {
      try {
        await owner.assertCurrent?.(signal);
        return undefined;
      } catch {
        return "this chat's runtime authorization changed.";
      }
    };
    const startup = await runtimeCurrent();
    if (startup) return refuse(startup);
    const decision = await authorize(owner, argv, signal);
    if ('refusal' in decision) return refuse(decision.refusal);
    signal.throwIfAborted();
    const before = (await runtimeCurrent()) ?? decision.current();
    if (before) return refuse(before);
    const result = await new Promise<BrokerReply>((resolveRun) => {
      execFile(
        binary,
        argv,
        {
          cwd: scratch,
          timeout: RUN_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          signal,
          env: { ...process.env, GOOGLE_WORKSPACE_CLI_LOG_FILE: '' },
        },
        (error, stdout, stderr) =>
          resolveRun({
            exitCode: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
            stdout,
            stderr:
              error && !stderr
                ? `gws: ${signal.aborted ? 'cancelled' : error.killed ? 'timed out' : 'failed'}\n`
                : stderr,
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
    signal.throwIfAborted();
    const after = (await runtimeCurrent()) ?? decision.current();
    if (after) return refuse(`${after} The command ran; its result was withheld.`);
    return { ...result, outputs };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function prepareSocketDirectory(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.uid !== process.getuid?.())
    throw Error('Unsafe gws broker directory');
  chmodSync(dir, 0o700);
}

const brokers = new Set<{ owner: GwsBrokerOwner; broker: GwsBroker }>();

/**
 * One broker per chat lifetime. Resolves undefined (and logs) when the socket
 * cannot be created, so an unavailable broker never fails the chat itself.
 */
export async function gwsBrokerForSession(owner: GwsBrokerOwner): Promise<GwsBroker | undefined> {
  // Reap brokers whose chats ended without reaching their lifetime signal.
  for (const entry of brokers) if (!entry.owner.resolve()) entry.broker.close();
  if (owner.lifetime.aborted) return;
  let socketPath: string;
  let shimPath: string;
  try {
    shimPath = installGwsShim();
    const dir = join(gwsBrokerRoot(), 's');
    prepareSocketDirectory(dir);
    socketPath = join(dir, `${randomBytes(8).toString('hex')}.sock`);
  } catch (error) {
    log.warn('gws broker unavailable', { error: (error as Error).message });
    return;
  }
  const token = randomBytes(32);
  const closing = new AbortController();
  let active = 0;
  const server: Server = createServer({ allowHalfOpen: true }, (connection) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cancel = new AbortController();
    const reply = (value: BrokerReply) => {
      if (!connection.destroyed) connection.end(JSON.stringify(value));
    };
    connection.on('error', () => cancel.abort());
    // The client exiting (interrupt or shell kill) cancels its host command.
    connection.on('close', () => cancel.abort());
    let started = false;
    // The request is one JSON line; afterwards the client keeps the connection
    // open, so its exit (interrupt or shell kill) cancels the host command.
    connection.on('end', () => cancel.abort());
    connection.on('data', (chunk: Buffer) => {
      if (started) return;
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        reply(refuse('request is too large.'));
        connection.destroy();
        return;
      }
      chunks.push(chunk);
      const newline = chunk.indexOf(10);
      if (newline < 0) return;
      started = true;
      const line = Buffer.concat(chunks).toString('utf8');
      handle(line.slice(0, line.indexOf('\n')));
    });
    const handle = (line: string) => {
      let request: BrokerRequest;
      try {
        request = parseRequest(line);
      } catch {
        return reply(refuse('invalid request.'));
      }
      const presented = Buffer.from(request.token, 'utf8');
      if (
        presented.length !== token.length * 2 ||
        !timingSafeEqual(presented, Buffer.from(token.toString('hex')))
      )
        return reply(refuse('this shell is not authorized for this chat.'));
      if (active >= MAX_CONCURRENT) return reply(refuse('too many gws commands at once; retry.'));
      active++;
      const signal = AbortSignal.any([
        cancel.signal,
        closing.signal,
        owner.lifetime,
        AbortSignal.timeout(10 * 60_000),
      ]);
      run(owner, request, signal)
        .catch(() => refuse(signal.aborted ? 'cancelled.' : 'the command could not run.'))
        .then(reply)
        .finally(() => active--);
    };
  });
  const listening = await new Promise<boolean>((done) => {
    server.once('error', (error) => {
      log.warn('gws broker could not listen', { error: error.message });
      done(false);
    });
    server.listen(socketPath, () => done(true));
  });
  // Later socket errors must never become an unhandled EventEmitter error.
  server.on('error', (error) => log.warn('gws broker error', { error: error.message }));
  if (!listening) {
    server.close();
    return;
  }
  server.unref();
  const entry = {
    owner,
    broker: {
      socketPath,
      shimPath,
      env: () => ({
        MITZO_GWS_SOCKET: socketPath,
        MITZO_GWS_TOKEN: token.toString('hex'),
        MITZO_GWS: shimPath,
      }),
      close: () => {
        if (!brokers.delete(entry)) return;
        owner.lifetime.removeEventListener('abort', onEnd);
        closing.abort();
        server.close();
        try {
          unlinkSync(socketPath);
        } catch {
          // already removed
        }
      },
    } satisfies GwsBroker,
  };
  const onEnd = () => entry.broker.close();
  brokers.add(entry);
  owner.lifetime.addEventListener('abort', onEnd, { once: true });
  if (owner.lifetime.aborted) {
    entry.broker.close();
    return;
  }
  return entry.broker;
}
