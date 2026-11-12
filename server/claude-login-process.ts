import { execFile, spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { claudeSdkExecutable, ClaudeSubscriptionCustody } from './claude-subscription-custody.js';
import type { ClaudeIdentity } from './claude-account-store.js';
import { credentialSdkBoundary } from './credential-sdk-boundary.js';
import { discoverClaudeModels } from './claude-model-discovery.js';

export class ClaudeLoginProcessError extends Error {
  readonly code = 'CLAUDE_LOGIN_PROCESS_FAILED';
  constructor(cause: unknown) {
    super('Claude sign-in could not complete. Check its status before retrying.', { cause });
  }
}
export interface ClaudeNativeLogin {
  url: string;
  completion: Promise<{ ok: true } | { ok: false; cause: Error }>;
  submit(code: string): Promise<void>;
  cancel(): Promise<void>;
}
function cleanEnvironment(config: string): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      ['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL'].flatMap((key) =>
        process.env[key] === undefined ? [] : [[key, process.env[key]!]],
      ),
    ),
    CLAUDE_CONFIG_DIR: config,
    BROWSER: '/usr/bin/false',
    DISABLE_AUTOUPDATER: '1',
  };
}
function custody(path: string, directory: boolean) {
  const stat = lstatSync(path, { bigint: true });
  if (
    realpathSync(path) !== path ||
    stat.uid !== BigInt(process.getuid!()) ||
    (directory
      ? !stat.isDirectory() || (stat.mode & 0o077n) !== 0n
      : !stat.isFile() || (stat.mode & 0o022n) !== 0n)
  )
    throw new ClaudeLoginProcessError(Error('Native login custody unavailable'));
  return JSON.stringify([
    String(stat.dev),
    String(stat.ino),
    String(stat.mode),
    ...(directory ? [] : [String(stat.size), String(stat.mtimeNs)]),
  ]);
}
function loginUrl(value: string) {
  const url = new URL(value);
  const allowed =
    (url.origin === 'https://claude.com' && url.pathname === '/cai/oauth/authorize') ||
    (url.origin === 'https://claude.ai' && url.pathname === '/oauth/authorize');
  if (
    !allowed ||
    url.username ||
    url.password ||
    url.hash ||
    ![
      'https://platform.claude.com/oauth/code/callback',
      'https://console.anthropic.com/oauth/code/callback',
    ].includes(url.searchParams.get('redirect_uri') || '') ||
    !url.searchParams.get('state') ||
    !url.searchParams.get('code_challenge') ||
    url.searchParams.get('code_challenge_method') !== 'S256'
  )
    throw new ClaudeLoginProcessError(Error('Native login URL unsupported'));
  return url.toString();
}

/** Wrap the documented native command; no token exchange or credential parsing in Mitzo. */
export async function createClaudeLoginProcess(
  config: string,
  signal: AbortSignal,
  options: { executable?: string } = {},
): Promise<ClaudeNativeLogin> {
  signal.throwIfAborted();
  const executable = realpathSync(options.executable || claudeSdkExecutable());
  const originalConfig = custody(config, true),
    originalExecutable = custody(executable, false);
  const assertCurrent = () => {
    if (
      custody(config, true) !== originalConfig ||
      custody(executable, false) !== originalExecutable
    )
      throw new ClaudeLoginProcessError(Error('Native login custody changed'));
  };
  // Native login must see the same storage restrictions as discovery/chat.
  // Otherwise it can save a keychain-only login that the SDK cannot subsequently
  // read. Claude owns its storage selection and fallback; Mitzo never copies tokens.
  const boundary = credentialSdkBoundary();
  const args = [
    fileURLToPath(new URL('./claude-login-supervisor.cjs', import.meta.url)),
    executable,
  ];
  const env = cleanEnvironment(config);
  const child = boundary
    ? boundary.spawnClaudeCodeProcess({
        command: process.execPath,
        args,
        cwd: config,
        env,
        signal,
        // Native authentication output can contain private authorization URLs.
        captureStderr: true,
      })
    : spawn(process.execPath, args, { cwd: config, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let finish!: (result: Awaited<ClaudeNativeLogin['completion']>) => void;
  const completion = new Promise<Awaited<ClaudeNativeLogin['completion']>>((resolve) => {
    finish = resolve;
  });
  let ready!: (url: string) => void, rejectReady!: (cause: Error) => void;
  const urlReady = new Promise<string>((resolve, reject) => {
    ready = resolve;
    rejectReady = reject;
  });
  let buffer = '',
    bytes = 0,
    urlFound = false,
    sent = false,
    failure: Error | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (child.exitCode != null || child.signalCode != null) return;
    child.kill('SIGTERM');
    escalation ??= setTimeout(() => {
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    }, 5000);
    escalation.unref();
  };
  const killTimer = setTimeout(() => {
    failure = new ClaudeLoginProcessError(Error('Native login expired'));
    stop();
  }, 10 * 60_000);
  killTimer.unref();
  const abort = () => {
    failure ??= new ClaudeLoginProcessError(signal.reason ?? Error('Native login cancelled'));
    stop();
  };
  signal.addEventListener('abort', abort, { once: true });
  const fail = (cause: unknown) => {
    failure ??=
      cause instanceof ClaudeLoginProcessError ? cause : new ClaudeLoginProcessError(cause);
    stop();
  };
  const startupTimer = setTimeout(
    () => fail(Error('Native login did not provide a sign-in link')),
    15_000,
  );
  startupTimer.unref();
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 32_768) return fail(Error('Native login output exceeded its bound'));
    if (urlFound) return;
    buffer += chunk.toString('utf8');
    const match = /If the browser didn't open, visit: (https:\/\/[^\s]+)\r?\n/.exec(buffer);
    if (match) {
      try {
        assertCurrent();
        const url = loginUrl(match[1]);
        urlFound = true;
        buffer = '';
        clearTimeout(startupTimer);
        ready(url);
      } catch (cause) {
        fail(cause);
      }
    }
  });
  // Drain but never retain/log raw native stderr: provider messages may contain secrets.
  child.stderr.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > 32_768) fail(Error('Native login output exceeded its bound'));
  });
  child.once('close', (code, termination) => {
    clearTimeout(killTimer);
    clearTimeout(startupTimer);
    clearTimeout(escalation);
    signal.removeEventListener('abort', abort);
    buffer = '';
    try {
      assertCurrent();
    } catch (cause) {
      failure ??= new ClaudeLoginProcessError(cause);
    }
    if (failure || code !== 0 || !urlFound) {
      const cause =
        failure ||
        new ClaudeLoginProcessError(Error(`Native login exited (${code ?? termination})`));
      if (!urlFound) rejectReady(cause);
      finish({ ok: false, cause });
    } else finish({ ok: true });
  });
  if (signal.aborted) abort();
  try {
    const url = await urlReady;
    return {
      url,
      completion,
      async submit(code) {
        signal.throwIfAborted();
        assertCurrent();
        if (sent || !code || /[\r\n]/.test(code) || code.length > 4096)
          throw new ClaudeLoginProcessError(Error('Login code unavailable'));
        sent = true;
        await new Promise<void>((resolve, reject) =>
          child.stdin.write(code + '\n', (error) =>
            error ? reject(new ClaudeLoginProcessError(error)) : resolve(),
          ),
        );
      },
      async cancel() {
        abort();
        await completion;
      },
    };
  } catch (cause) {
    abort();
    await completion;
    throw cause;
  }
}

/** Native status is bounded and verified without inference. Never reads credential files. */
export async function verifyClaudeLoginIdentity(
  config: string,
  signal: AbortSignal,
): Promise<ClaudeIdentity> {
  const executable = claudeSdkExecutable(),
    env = cleanEnvironment(config);
  const { stdout } = await promisify(execFile)(executable, ['auth', 'status', '--json'], {
    env,
    cwd: config,
    signal,
    timeout: 10_000,
    maxBuffer: 32_768,
    encoding: 'utf8',
  });
  const status = z
    .object({
      loggedIn: z.literal(true),
      authMethod: z.literal('claude.ai'),
      apiProvider: z.literal('firstParty'),
      email: z.email(),
      subscriptionType: z.enum(['pro', 'max']),
    })
    .parse(JSON.parse(stdout));
  const selected = {
    ...env,
    MITZO_CLAUDE_EXPECTED_EMAIL: status.email,
    MITZO_CLAUDE_EXPECTED_PLAN: status.subscriptionType,
  };
  await ClaudeSubscriptionCustody.capture(selected, executable).verify(selected, signal);
  // A CLI-only success cannot qualify the SDK route used by chat. This is a
  // tool-free metadata query; no model turn or paid inference is submitted.
  await discoverClaudeModels(selected, AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
  signal.throwIfAborted();
  return { email: status.email, planType: status.subscriptionType };
}
