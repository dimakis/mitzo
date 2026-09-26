import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { beginDeviceLogin, deviceLoginProcessSpec } from '../symposium-device-login.js';

function fixture(options: { unsupported?: boolean; wrongMode?: boolean; early?: boolean } = {}) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 123,
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit('exit', 0));
      return true;
    }),
  });
  let home = '';
  const requests: Record<string, unknown>[] = [];
  const install = vi.fn().mockResolvedValue({ accountId: 'personal' });
  const service = { beginDevice: vi.fn(() => install), invalidate: vi.fn() };
  const emit = (message: unknown) => child.stdout.write(JSON.stringify(message) + '\n');
  child.stdin.on('data', (data) => {
    for (const line of String(data).trim().split('\n')) {
      const message = JSON.parse(line);
      requests.push(message);
      if (message.id == null) continue;
      if (message.method === 'account/login/start') {
        if (options.early) complete();
        emit({
          id: message.id,
          result: options.unsupported
            ? { type: 'chatgpt', authUrl: 'https://secret.invalid' }
            : {
                type: 'chatgptDeviceCode',
                loginId: 'login-1',
                verificationUrl: 'https://auth.openai.com/codex/device',
                userCode: 'ABCD-1234',
              },
        });
      } else emit({ id: message.id, result: {} });
    }
  });
  const launch = vi.fn((_command, _args, spec) => {
    home = spec.env.HOME;
    return child;
  });
  const complete = (loginId = 'login-1', success = true) => {
    writeFileSync(
      join(home, 'codex', 'auth.json'),
      JSON.stringify({
        auth_mode: options.wrongMode ? 'apikey' : 'chatgpt',
        tokens: {
          access_token: 'secret-access',
          refresh_token: 'secret-refresh',
          id_token: 'secret-id',
          account_id: 'personal',
        },
      }),
      { mode: 0o600 },
    );
    emit({
      method: 'account/login/completed',
      params: { loginId, success, error: 'never expose secret' },
    });
  };
  return { child, service, install, launch, complete, requests, home: () => home };
}

describe('isolated upstream device authentication', () => {
  it('launches with isolated file credentials, imports only matching completion, and reaps before cleanup', async () => {
    const f = fixture();
    const login = await beginDeviceLogin(f.service as never, f.launch as never);
    expect(login.verificationUrl).toBe('https://auth.openai.com/codex/device');
    const spec = f.launch.mock.calls[0][2];
    expect(spec.env.CODEX_HOME).toBe(join(f.home(), 'codex'));
    expect(spec.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(spec.env).not.toHaveProperty('CODEX_ACCESS_TOKEN');
    expect(spec.cwd).toBe(f.home());
    expect(JSON.stringify(f.requests)).not.toMatch(/thread\/|turn\/|model\/|apiKey/);
    f.complete('wrong-login');
    expect(f.install).not.toHaveBeenCalled();
    f.complete();
    await expect(login.completed).resolves.toMatchObject({ accountId: 'personal' });
    expect(f.child.kill).toHaveBeenCalled();
    expect(f.install).toHaveBeenCalledWith(expect.objectContaining({ account_id: 'personal' }));
    expect(existsSync(f.home())).toBe(false);
  });
  it('cancels physically without importing late success and does not use a browser fallback', async () => {
    const f = fixture();
    const login = await beginDeviceLogin(f.service as never, f.launch as never);
    await login.cancel();
    await expect(login.completed).rejects.toThrow('retry explicitly');
    expect(f.install).not.toHaveBeenCalled();
    expect(existsSync(f.home())).toBe(false);
    expect(f.requests.some((request) => request.method === 'account/login/cancel')).toBe(true);
    const unsupported = fixture({ unsupported: true });
    await expect(
      beginDeviceLogin(unsupported.service as never, unsupported.launch as never),
    ).rejects.toThrow('no browser fallback');
    expect(existsSync(unsupported.home())).toBe(false);
  });
  it('rejects an API-key cache and keeps raw errors out of completion', async () => {
    const f = fixture({ wrongMode: true });
    const login = await beginDeviceLogin(f.service as never, f.launch as never);
    f.complete();
    await expect(login.completed).rejects.toThrow('Device login did not complete');
    expect(f.install).not.toHaveBeenCalled();
    expect(existsSync(f.home())).toBe(false);
  });
  it('does not inherit host credential or configuration environment', () => {
    const spec = deviceLoginProcessSpec('/isolated', '/usr/bin');
    expect(Object.keys(spec.env).sort()).toEqual([
      'CODEX_HOME',
      'HOME',
      'PATH',
      'XDG_CACHE_HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
    ]);
    expect(spec.args).toContain('cli_auth_credentials_store="file"');
  });
});

it('leaves an unconfirmed process quarantined with no credential import', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.child.kill.mockImplementation(() => true);
  try {
    const login = await beginDeviceLogin(f.service as never, f.launch as never);
    const cancel = login.cancel();
    const rejected = expect(cancel).rejects.toThrow('cleanup is unconfirmed');
    await vi.advanceTimersByTimeAsync(2001);
    await rejected;
    await expect(login.completed).rejects.toThrow('cleanup is unconfirmed');
    expect(f.child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(f.install).not.toHaveBeenCalled();
    expect(existsSync(f.home())).toBe(true);
  } finally {
    vi.useRealTimers();
    rmSync(f.home(), { recursive: true, force: true });
  }
});

it('handles matching completion before the device start response without losing the receipt', async () => {
  const f = fixture({ early: true });
  const login = await beginDeviceLogin(f.service as never, f.launch as never);
  await expect(login.completed).resolves.toMatchObject({ accountId: 'personal' });
  expect(f.install).toHaveBeenCalledOnce();
  expect(existsSync(f.home())).toBe(false);
});

it('rejects and quarantines credential deletion failure before success without unhandled rejection', async () => {
  const f = fixture();
  const unhandled = vi.fn();
  process.on('unhandledRejection', unhandled);
  try {
    const login = await beginDeviceLogin(f.service as never, f.launch as never, () => {
      throw new Error('private filesystem diagnostic');
    });
    f.complete();
    await expect(login.completed).rejects.toThrow('cleanup is unconfirmed');
    await expect(login.cancel()).rejects.toThrow('cleanup is unconfirmed');
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).not.toHaveBeenCalled();
    expect(f.install).not.toHaveBeenCalled();
    expect(f.service.invalidate).toHaveBeenCalled();
    expect(existsSync(f.home())).toBe(true);
  } finally {
    process.off('unhandledRejection', unhandled);
    rmSync(f.home(), { recursive: true, force: true });
  }
});
