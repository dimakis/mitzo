import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  chmodSync,
  openSync,
  fstatSync,
  readFileSync,
  closeSync,
  rmSync,
  constants,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServerClient } from './codex-app-server-client.js';
import type {
  SubscriptionTokens,
  SymposiumSubscriptionProvisioner,
} from './symposium-subscription-provisioner.js';

export class DeviceLoginCleanupError extends Error {
  constructor() {
    super('Device login cleanup is unconfirmed; host recovery required');
  }
}

export const DEVICE_LOGIN_WINDOW_MS = 10 * 60_000;
export interface DeviceLogin {
  verificationUrl: string;
  userCode: string;
  expiresAt: number;
  completed: Promise<unknown>;
  cancel(): Promise<void>;
}

/** Only the login process gets this fresh home; no host environment is mutated. */
export function deviceLoginProcessSpec(home: string, path: string | undefined) {
  return {
    command: 'codex',
    args: [
      'app-server',
      '--stdio',
      '-c',
      'forced_login_method="chatgpt"',
      '-c',
      'cli_auth_credentials_store="file"',
      '-c',
      'model_provider="openai"',
    ],
    env: {
      PATH: path,
      HOME: home,
      CODEX_HOME: join(home, 'codex'),
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_DATA_HOME: join(home, 'data'),
      XDG_CACHE_HOME: join(home, 'cache'),
    },
  };
}

function readTokens(path: string): SubscriptionTokens {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 64 * 1024 ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()
    )
      throw new Error('Invalid isolated credential cache');
    const auth = JSON.parse(readFileSync(fd, 'utf8')) as Record<string, unknown>;
    if (
      auth.auth_mode !== 'chatgpt' ||
      auth.OPENAI_API_KEY ||
      !auth.tokens ||
      typeof auth.tokens !== 'object'
    )
      throw new Error('Unexpected isolated authentication mode');
    const tokens = auth.tokens as SubscriptionTokens;
    if (
      ['access_token', 'refresh_token', 'id_token', 'account_id'].some(
        (key) =>
          typeof tokens[key as keyof SubscriptionTokens] !== 'string' ||
          !tokens[key as keyof SubscriptionTokens],
      )
    )
      throw new Error('Incomplete isolated credentials');
    return tokens;
  } finally {
    closeSync(fd);
  }
}

/** Uses only upstream login RPCs. No model/thread request, shared auth or API-key fallback. */
export async function beginDeviceLogin(
  service: SymposiumSubscriptionProvisioner,
  launch: typeof spawn = spawn,
): Promise<DeviceLogin> {
  const importTokens = service.beginDevice();
  const home = mkdtempSync(join(tmpdir(), 'mitzo-device-login-'));
  chmodSync(home, 0o700);
  mkdirSync(join(home, 'codex'), { mode: 0o700 });
  const spec = deviceLoginProcessSpec(home, process.env.PATH);
  let child: ReturnType<typeof spawn>;
  try {
    child = launch(spec.command, spec.args, {
      env: spec.env,
      cwd: home,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    service.invalidate();
    rmSync(home, { recursive: true, force: true });
    throw new Error('Device login could not start');
  }
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    child.once('exit', () => {
      exited = true;
      resolve();
    });
    child.once('error', () => {
      if (!child.pid) {
        exited = true;
        resolve();
      }
    });
  });
  let loginId: string | undefined;
  let early: { loginId: string; success: boolean } | undefined;
  let sealed = false;
  let cancelled = false;
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const completed = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void completed.catch(() => undefined);
  let cleanup: Promise<void> | undefined;
  const reap = () =>
    (cleanup ??= (async () => {
      client.close();
      if (!exited) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          exit,
          new Promise<void>((yes) => {
            timer = setTimeout(yes, 1000);
            timer.unref();
          }),
        ]);
        if (timer) clearTimeout(timer);
      }
      if (!exited) {
        child.kill('SIGKILL');
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          exit,
          new Promise<void>((yes) => {
            timer = setTimeout(yes, 1000);
            timer.unref();
          }),
        ]);
        if (timer) clearTimeout(timer);
      }
      if (!exited) throw new DeviceLoginCleanupError();
    })());
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const finish = async (success: boolean) => {
    if (sealed) return;
    sealed = true;
    if (expiry) clearTimeout(expiry);
    try {
      await reap();
      if (!success || cancelled) throw new Error('Device login did not complete');
      const tokens = readTokens(join(home, 'codex', 'auth.json'));
      const result = await importTokens(tokens);
      if (cancelled) throw new Error('Device login cancelled');
      resolve(result);
    } catch {
      service.invalidate();
      reject(
        exited
          ? new Error('Device login did not complete; retry explicitly')
          : new DeviceLoginCleanupError(),
      );
    } finally {
      if (exited) rmSync(home, { recursive: true, force: true });
    }
  };
  const client = new CodexAppServerClient(child as never, {
    loginOnly: true,
    lifecycle: {
      onNotification(method, params) {
        if (
          method !== 'account/login/completed' ||
          typeof params.loginId !== 'string' ||
          typeof params.success !== 'boolean'
        )
          return;
        if (!loginId) {
          early = { loginId: params.loginId, success: params.success };
          return;
        }
        if (params.loginId === loginId) void finish(params.success);
      },
      async onRequest() {
        throw new Error('Device login cannot execute host requests');
      },
      onClose() {
        if (!sealed) void finish(false);
      },
    },
  });
  try {
    await client.initialize();
    const result = (await client.request('account/login/start', {
      type: 'chatgptDeviceCode',
    })) as Record<string, unknown>;
    if (
      result.type !== 'chatgptDeviceCode' ||
      typeof result.loginId !== 'string' ||
      !result.loginId ||
      result.verificationUrl !== 'https://auth.openai.com/codex/device' ||
      typeof result.userCode !== 'string' ||
      !/^[A-Za-z0-9-]{4,32}$/.test(result.userCode)
    )
      throw new Error('Device login is unsupported');
    loginId = result.loginId;
    const expiresAt = Date.now() + DEVICE_LOGIN_WINDOW_MS;
    expiry = setTimeout(() => {
      cancelled = true;
      service.invalidate();
      void finish(false);
    }, DEVICE_LOGIN_WINDOW_MS);
    expiry.unref();
    if (early?.loginId === loginId) void finish(early.success);
    return {
      verificationUrl: result.verificationUrl,
      userCode: result.userCode,
      expiresAt,
      completed,
      async cancel() {
        cancelled = true;
        service.invalidate();
        // A failed/unsupported cancel RPC cannot prevent physical termination.
        if (!sealed) {
          void client.request('account/login/cancel', { loginId }).catch(() => undefined);
          await finish(false);
        }
        await reap();
        await completed.catch(() => undefined);
      },
    };
  } catch {
    cancelled = true;
    service.invalidate();
    await finish(false);
    if (!exited) throw new DeviceLoginCleanupError();
    throw new Error('Device login is unavailable; no browser fallback was started');
  }
}
