/** Operator-enrolled separate process. A plugin never selects executable code or host paths. */
import { execFile, spawn } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { CalendarResponse } from './api-schemas.js';

const exec = promisify(execFile);
const absolute = z.string().refine(isAbsolute);
const Enrollment = z
  .object({
    kind: z.literal('workspace-runtime-v1'),
    release: absolute,
    releaseCommit: z.string().regex(/^[a-f0-9]{40}$/),
    python: absolute,
    config: absolute,
    briefingsRoot: absolute,
  })
  .strict();
const RuntimeConfig = z
  .object({
    configPath: absolute,
    relationshipsPath: absolute,
    dataRoot: absolute,
    briefingsRoot: absolute,
    inboxRoot: absolute,
    jiraLibPath: absolute,
    gwsExecutable: absolute,
    jiraLibSha256: z.string().regex(/^[a-f0-9]{64}$/),
    contexginUrl: z.url().default('http://127.0.0.1:4195'),
  })
  .strict();
const Describe = z
  .object({
    protocol: z.literal('workspace-runtime-v1'),
    version: z.literal('0.1.0'),
    operations: z.array(z.enum(['calendar.read', 'briefings.latest'])),
  })
  .strict();
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(value);
    return !isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
  });
const CalendarInput = z.object({ date, days: z.number().int().min(1).max(31) }).strict();
const BriefingInput = z.object({ date }).strict();
const Briefing = z
  .object({
    filename: z.string(),
    artifact: z.string(),
    date,
    generatedAt: z.string().refine((value) => !isNaN(Date.parse(value))),
  })
  .strict()
  .nullable();
const environmentKeys = [
  'HOME',
  'PATH',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'USER',
  'LOGNAME',
  'JIRA_URL',
  'JIRA_EMAIL',
  'JIRA_API_TOKEN',
  'GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE',
  'GOOGLE_WORKSPACE_CLI_TOKEN',
  'GOOGLE_WORKSPACE_CLI_CONFIG_DIR',
  'GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND',
  'GOOGLE_WORKSPACE_CLI_CLIENT_ID',
  'GOOGLE_WORKSPACE_CLI_CLIENT_SECRET',
] as const;

/** Own the provider process group so aborts cannot leave gws/Jira helpers running. */
function runtimeProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
    maxBytes: number;
  },
): Promise<string> {
  options.signal.throwIfAborted();
  return new Promise((done, fail) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: grouped,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const kill = () => {
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* The owned process group has already exited. */
      }
    };
    const reject = (error: Error) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener('abort', abort);
      kill();
      fail(error);
    };
    const abort = () => reject(new Error('Workspace runtime cancelled'));
    options.signal.addEventListener('abort', abort, { once: true });
    if (options.signal.aborted) abort();
    const capture = (chunk: Buffer, stdout: boolean) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > options.maxBytes) reject(new Error('Workspace runtime output limit exceeded'));
      else if (stdout) chunks.push(chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => capture(chunk, true));
    child.stderr.on('data', (chunk: Buffer) => capture(chunk, false));
    child.once('error', () => reject(new Error('Workspace runtime process unavailable')));
    // Exit rather than close: a stray descendant may retain an inherited pipe after Python exits.
    child.once('exit', () => kill());
    child.once('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        reject(new Error('Workspace runtime process failed'));
        return;
      }
      settled = true;
      options.signal.removeEventListener('abort', abort);
      done(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

function physical(path: string, kind: 'file' | 'directory', privateFile = false) {
  const stat = lstatSync(path);
  if (
    realpathSync(path) !== resolve(path) ||
    (kind === 'file' ? !stat.isFile() : !stat.isDirectory())
  )
    throw new Error('Workspace runtime path is not physical');
  if (
    privateFile &&
    (stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0)
  )
    throw new Error('Workspace runtime configuration must be private');
}
function load(path: string) {
  if (!isAbsolute(path)) throw new Error('Workspace runtime enrollment must be absolute');
  physical(path, 'file', true);
  const enrollment = Enrollment.parse(JSON.parse(readFileSync(path, 'utf8')));
  physical(enrollment.config, 'file', true);
  const config = RuntimeConfig.parse(JSON.parse(readFileSync(enrollment.config, 'utf8')));
  if (config.briefingsRoot !== enrollment.briefingsRoot)
    throw new Error('Workspace runtime briefing root mismatch');
  physical(enrollment.briefingsRoot, 'directory');
  physical(enrollment.release, 'directory');
  physical(join(enrollment.release, '.git'), 'directory');
  physical(join(enrollment.release, 'run-runtime.py'), 'file');
  // Homebrew interpreter links are operator-owned enrollment; resolve them to a regular executable.
  const interpreter = lstatSync(realpathSync(enrollment.python));
  if (!interpreter.isFile() || !(interpreter.mode & 0o111))
    throw new Error('Workspace runtime interpreter is not executable');
  return enrollment;
}

/** Compare physical bytes with Git objects; index flags and clean filters cannot hide drift. */
async function verifyRelease(
  release: string,
  commit: string,
  git: (...args: string[]) => Promise<string>,
) {
  const config = await git('config', '--local', '--no-includes', '--null', '--list');
  for (const entry of config.split('\0')) {
    const key = entry.split('\n')[0]?.toLowerCase() ?? '';
    if (
      /^(filter\.|include\.|includeif\.|core\.(fsmonitor|worktree)$|extensions\.worktreeconfig$)/.test(
        key,
      )
    )
      throw new Error('Workspace runtime Git controls are not supported');
  }
  if (
    (await git('rev-parse', '--show-toplevel')) !== release ||
    (await git('rev-parse', 'HEAD')) !== commit ||
    (await git('branch', '--show-current'))
  )
    throw new Error('Workspace runtime requires a pinned detached release');
  const entries = (await git('ls-tree', '-r', '-z', '--full-tree', 'HEAD'))
    .split('\0')
    .filter(Boolean);
  const tracked = new Map<string, { mode: string; hash: string }>();
  for (const entry of entries) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error('Workspace runtime tree contains unsupported entries');
    const mode = match[1]!;
    const hash = match[2]!;
    const relative = match[3]!;
    const file = join(release, relative);
    physical(file, 'file');
    const stat = lstatSync(file);
    const bytes = readFileSync(file);
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    if (blob !== hash || Boolean(stat.mode & 0o111) !== (mode === '100755'))
      throw new Error('Workspace runtime source bytes or modes changed');
    tracked.set(relative, { mode, hash });
  }
  if (!tracked.has('run-runtime.py')) throw new Error('Workspace runtime launcher is untracked');
  const staged = (await git('ls-files', '--stage', '-z')).split('\0').filter(Boolean);
  if (staged.length !== tracked.size) throw new Error('Workspace runtime index changed');
  for (const entry of staged) {
    const match = /^(100644|100755) ([a-f0-9]{40}) 0\t([\s\S]+)$/.exec(entry);
    const expected = match && tracked.get(match[3]!);
    if (!match || !expected || expected.mode !== match[1] || expected.hash !== match[2])
      throw new Error('Workspace runtime index changed');
  }
  const walk = (directory: string, prefix: string) => {
    for (const name of readdirSync(directory)) {
      if (!prefix && name === '.git') continue;
      const relative = prefix + name;
      const file = join(directory, name);
      const stat = lstatSync(file);
      if (stat.isDirectory()) {
        physical(file, 'directory');
        walk(file, relative + '/');
      } else if (!stat.isFile() || !tracked.has(relative))
        throw new Error('Workspace runtime contains untracked or linked files');
    }
  };
  walk(release, '');
}
export function workspaceRuntimeConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Object.hasOwn(env, 'MITZO_WORKSPACE_RUNTIME_CONFIG');
}

export interface WorkspaceRuntimeClientOptions {
  /** Deterministic process controls for tests; deployment uses the bounded defaults. */
  timeoutMs?: number;
  maxBytes?: number;
  env?: NodeJS.ProcessEnv;
}
export function createWorkspaceRuntimeClient(
  path: string,
  options: WorkspaceRuntimeClientOptions = {},
) {
  const enrollment = load(path);
  const env = Object.fromEntries(
    environmentKeys.flatMap((key) => {
      const value = (options.env ?? process.env)[key];
      return typeof value === 'string' ? [[key, value]] : [];
    }),
  );
  const timeout = options.timeoutMs ?? 20_000;
  const maxBuffer = options.maxBytes ?? 8 * 1024 * 1024;
  async function invoke(
    operation: 'calendar.read' | 'briefings.latest',
    input: unknown,
    signal?: AbortSignal,
  ) {
    const deadline = AbortSignal.timeout(timeout);
    const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
    abort.throwIfAborted();
    // Recheck every use: configured failure can never fall back to the mutable workspace.
    if (JSON.stringify(load(path)) !== JSON.stringify(enrollment))
      throw new Error('Workspace runtime enrollment changed');
    const git = async (...args: string[]) =>
      (
        await exec(
          '/usr/bin/git',
          [
            '-c',
            'core.hooksPath=/dev/null',
            '-c',
            'core.fsmonitor=false',
            '-C',
            enrollment.release,
            ...args,
          ],
          {
            env: {
              ...env,
              GIT_CONFIG_NOSYSTEM: '1',
              GIT_CONFIG_GLOBAL: '/dev/null',
              GIT_NO_REPLACE_OBJECTS: '1',
            },
            signal: abort,
            timeout,
            maxBuffer,
          },
        )
      ).stdout.trim();
    await verifyRelease(enrollment.release, enrollment.releaseCommit, git);
    const run = async (op: string, payload: unknown) => {
      const stdout = await runtimeProcess(
        enrollment.python,
        [
          '-I',
          '-B',
          join(enrollment.release, 'run-runtime.py'),
          '--config',
          enrollment.config,
          '--operation',
          op,
          '--input',
          JSON.stringify(payload),
        ],
        { cwd: enrollment.release, env, signal: abort, maxBytes: maxBuffer },
      );
      return JSON.parse(stdout) as unknown;
    };
    const description = Describe.parse(await run('runtime.describe', {}));
    if (new Set(description.operations).size !== 2 || !description.operations.includes(operation))
      throw new Error('Workspace runtime operations mismatch');
    return run(operation, input);
  }
  return {
    briefingsRoot: enrollment.briefingsRoot,
    async calendar(input: z.infer<typeof CalendarInput>, signal?: AbortSignal) {
      const request = CalendarInput.parse(input);
      const result = CalendarResponse.strict().parse(
        await invoke('calendar.read', request, signal),
      );
      const end = new Date(request.date);
      end.setUTCDate(end.getUTCDate() + request.days - 1);
      if (result.startDate !== request.date || result.endDate !== end.toISOString().slice(0, 10))
        throw new Error('Workspace runtime returned another calendar interval');
      return result;
    },
    async latestBriefing(input: z.infer<typeof BriefingInput>, signal?: AbortSignal) {
      const request = BriefingInput.parse(input);
      const result = Briefing.parse(await invoke('briefings.latest', request, signal));
      if (!result) return null;
      const normal = /^morning_(\d{4}-\d{2}-\d{2})_\d{4}\.md$/.exec(result.artifact);
      const legacy = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(result.artifact);
      if (
        result.date !== request.date ||
        result.filename !== result.artifact ||
        (normal ?? legacy)?.[1] !== request.date
      )
        throw new Error('Workspace runtime briefing artifact mismatch');
      physical(enrollment.briefingsRoot, 'directory');
      const artifact = join(enrollment.briefingsRoot, result.artifact);
      physical(artifact, 'file');
      return {
        filename: result.filename,
        date: result.date,
        generatedAt: result.generatedAt,
        path: artifact,
      };
    },
  };
}
