import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { KeychainRotationCredentials } from '../keychain-rotation-credentials.js';
import { OpenShellOpenAIKeyGateway, validateOpenAIKey } from '../openai-key-gateway.js';
import type { ManagedOpenAIAccount } from '../openai-key-management.js';
const account: ManagedOpenAIAccount = {
  id: 'work',
  label: 'Work API',
  providerName: 'work-api',
  providerId: 'provider-id',
  credentialRef: { provider: 'keychain', service: 'service', account: 'work' },
};
const signal = () => AbortSignal.timeout(5000);
const profile = () =>
  load(
    readFileSync(
      new URL(
        '../../docs/spikes/openshell-codex/openai-keychain-spike-profile.yaml',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as Record<string, unknown>;
describe('Keychain rotation adapter', () => {
  it('uses stdin for the key and writes an atomic version marker rather than secret argv', async () => {
    const run = vi.fn<(stdin: string, signal: AbortSignal) => Promise<string>>(
      async () => '{"ok":true}',
    );
    const adapter = new KeychainRotationCredentials(run);
    await adapter.write(
      account.credentialRef,
      'NEW_PRIVATE_KEY',
      '890456d2-8b5d-43d6-b8b8-48c1c99837c0',
      signal(),
    );
    const input = JSON.parse(run.mock.calls[0]![0]);
    expect(input).toEqual({
      action: 'write',
      service: 'service',
      account: 'work',
      value: 'NEW_PRIVATE_KEY',
      version: '890456d2-8b5d-43d6-b8b8-48c1c99837c0',
      expectedVersion: null,
    });
    await expect(
      adapter.read({ ...account.credentialRef, provider: 'other' }, signal()),
    ).rejects.toThrow('Keychain unavailable');
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('accepts only the versioned helper contract and never returns native errors', async () => {
    const run = vi.fn(async () => '{"value":"PRIVATE_KEY","version":null,"managed":false}');
    const adapter = new KeychainRotationCredentials(run);
    expect(await adapter.read(account.credentialRef, signal())).toEqual({
      value: 'PRIVATE_KEY',
      version: null,
      managed: false,
    });
    run.mockRejectedValueOnce(new Error('PRIVATE_KEY in stderr'));
    await expect(adapter.read(account.credentialRef, signal())).rejects.toThrow(
      /^Keychain unavailable$/,
    );
    run.mockResolvedValueOnce('{"value":"PRIVATE_KEY","version":"unknown-metadata"}');
    await expect(adapter.read(account.credentialRef, signal())).rejects.toThrow(
      /^Keychain unavailable$/,
    );
  });
});
function gatewayFixture() {
  let version = 10;
  let providerId = account.providerId;
  let policy = profile();
  let apiSupported = true;
  let apiDrift = false;
  let concurrentUpdate = false;
  const run = vi.fn(async (args: readonly string[], _options: unknown) => {
    if (args[1] === 'profile') return JSON.stringify(policy);
    if (args[1] === 'update') throw new Error('CLI updates are forbidden');
    return JSON.stringify([
      {
        id: providerId,
        name: account.providerName,
        workspace: 'default',
        type: 'mitzo-openai-keychain-spike',
        resource_version: version,
        credential_keys: ['OPENAI_API_KEY'],
        config_keys: [],
      },
    ]);
  });
  const sandboxes = {
    attachments: vi.fn(async () => ['retained-chat']),
    stopSandbox: vi.fn(async (_name: string, _signal: AbortSignal) => {}),
    sandboxStopped: vi.fn(async (_name: string, _signal: AbortSignal) => true),
  };
  const api = {
    inspect: vi.fn(async () => {
      if (!apiSupported) throw new Error('unavailable');
      return { version: apiDrift ? '99' : String(version) };
    }),
    replace: vi.fn(
      async (
        _account: ManagedOpenAIAccount,
        _value: string,
        expectedVersion: string,
        _signal: AbortSignal,
      ) => {
        if (concurrentUpdate) version++;
        if (expectedVersion !== String(version)) throw new Error('conflict');
        version++;
        return { version: String(version) };
      },
    ),
  };
  const gateway = new OpenShellOpenAIKeyGateway(run, 'default', sandboxes, api);
  return {
    gateway,
    run,
    sandboxes,
    api,
    driftApi: () => {
      apiDrift = true;
    },
    disableAPI: () => {
      apiSupported = false;
    },
    raceUpdate: () => {
      concurrentUpdate = true;
    },
    setPolicy: (value: Record<string, unknown>) => {
      policy = value;
    },
    driftId: () => {
      providerId = 'wrong-id';
    },
    driftPolicy: () => {
      policy = { ...policy, binaries: ['/usr/bin/sh'] };
    },
  };
}
describe('OpenShell OpenAI credential adapter', () => {
  it('drains many attached chats concurrently within a bound and waits for every stop acknowledgement', async () => {
    const f = gatewayFixture();
    const names = Array.from({ length: 9 }, (_, index) => `chat-${index}`);
    const stopped = new Set<string>();
    let inFlight = 0;
    let maximum = 0;
    f.sandboxes.attachments.mockResolvedValue(names);
    f.sandboxes.sandboxStopped.mockImplementation(async (name) => stopped.has(name));
    f.sandboxes.stopSandbox.mockImplementation(async (name) => {
      maximum = Math.max(maximum, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      stopped.add(name);
      inFlight--;
    });
    await f.gateway.pause(account, signal());
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(4);
    expect(stopped.size).toBe(names.length);
    expect(inFlight).toBe(0);
    expect(f.api.replace).not.toHaveBeenCalled();
  });
  it('awaits in-flight drains after a failure and does not start the next batch or replace credentials', async () => {
    const f = gatewayFixture();
    f.sandboxes.attachments.mockResolvedValue(['failed', 'held', 'third', 'fourth', 'later']);
    const stopped = new Set<string>();
    f.sandboxes.sandboxStopped.mockImplementation(async (name) => stopped.has(name));
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.sandboxes.stopSandbox.mockImplementation(async (name) => {
      if (name === 'failed') throw new Error('PRIVATE_ERROR');
      if (name === 'held') await held;
      stopped.add(name);
    });
    let settled = false;
    const outcome = f.gateway.pause(account, signal()).catch((error: unknown) => {
      settled = true;
      return error;
    });
    await vi.waitFor(() =>
      expect(f.sandboxes.stopSandbox).toHaveBeenCalledWith('held', expect.any(AbortSignal)),
    );
    expect(settled).toBe(false);
    release();
    expect(await outcome).toEqual(new Error('OpenAI chats could not be paused'));
    expect(f.sandboxes.stopSandbox).not.toHaveBeenCalledWith('later', expect.any(AbortSignal));
    expect(f.api.replace).not.toHaveBeenCalled();
  });
  it('pins provider identity and policy, stops retained workloads, and keeps credential writes out of CLI argv/env', async () => {
    const f = gatewayFixture();
    expect(await f.gateway.inspect(account, signal())).toEqual({ version: '10' });
    f.sandboxes.sandboxStopped.mockResolvedValueOnce(false);
    await f.gateway.pause(account, signal());
    expect(f.sandboxes.stopSandbox).toHaveBeenCalledWith('retained-chat', expect.any(AbortSignal));
    expect(await f.gateway.replace(account, 'PRIVATE_KEY', '10', signal())).toEqual({
      version: '11',
    });
    expect(f.api.replace).toHaveBeenCalledWith(
      account,
      'PRIVATE_KEY',
      '10',
      expect.any(AbortSignal),
    );
    expect(
      f.run.mock.calls.every(([, options]) => !JSON.stringify(options).includes('PRIVATE_KEY')),
    ).toBe(true);
    expect(f.run.mock.calls.some(([args]) => args[1] === 'update')).toBe(false);
  });
  it('does not stop an already stopped retained sandbox', async () => {
    const f = gatewayFixture();
    await f.gateway.pause(account, signal());
    expect(f.sandboxes.stopSandbox).not.toHaveBeenCalled();
  });
  it('refuses provider substitution and policy changes before credentials are submitted', async () => {
    for (const drift of ['driftId', 'driftPolicy'] as const) {
      const f = gatewayFixture();
      f[drift]();
      await expect(f.gateway.replace(account, 'PRIVATE_KEY', '10', signal())).rejects.toThrow(
        'OpenAI provider binding changed',
      );
      expect(
        f.run.mock.calls.some(([args]) => args[1] === 'update' && !args.includes('--help')),
      ).toBe(false);
    }
  });
  it('refuses credential replacement when a retained sandbox cannot be confirmed stopped', async () => {
    const f = gatewayFixture();
    f.sandboxes.sandboxStopped.mockResolvedValue(false);
    await expect(f.gateway.pause(account, signal())).rejects.toThrow(
      'OpenAI chats could not be paused',
    );
  });
});
describe('bounded Luna-only OpenAI validation', () => {
  it('checks availability and then performs one low-effort Luna request without tools or fallback', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'gpt-6-luna' }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'completed',
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'MITZO_KEY_OK' }] }],
          }),
          { status: 200 },
        ),
      );
    await validateOpenAIKey('PRIVATE_KEY', signal(), request);
    expect(request).toHaveBeenCalledWith(
      'https://api.openai.com/v1/models/gpt-6-luna',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: { Authorization: 'Bearer PRIVATE_KEY' },
      }),
    );
    expect(request).toHaveBeenCalledTimes(2);
    const [url, init] = request.mock.calls[1]!;
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(JSON.parse(init.body)).toMatchObject({
      model: 'gpt-6-luna',
      reasoning: { effort: 'low' },
      store: false,
      max_output_tokens: 256,
    });
    expect(JSON.parse(init.body)).not.toHaveProperty('tools');
    expect(init.body).not.toContain('PRIVATE_KEY');
  });
  it('rejects keys that can list models but cannot complete an inference request', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"id":"gpt-6-luna"}', { status: 200 }))
      .mockResolvedValueOnce(new Response('PRIVATE_KEY in upstream rejection', { status: 403 }));
    await expect(validateOpenAIKey('PRIVATE_KEY', signal(), request)).rejects.toThrow(
      'OpenAI key validation failed',
    );
  });
  it('redacts rejected project keys, unavailable models and malformed responses', async () => {
    for (const response of [
      new Response('PRIVATE_KEY', { status: 401 }),
      new Response('{}', { status: 404 }),
      new Response('{"id":"gpt-6-astra"}', { status: 200 }),
    ]) {
      await expect(
        validateOpenAIKey(
          'PRIVATE_KEY',
          signal(),
          vi.fn(async () => response),
        ),
      ).rejects.toThrow('OpenAI key validation failed');
    }
  });
});

it('requires the conditional API before a replacement can be offered', async () => {
  const f = gatewayFixture();
  f.disableAPI();
  await expect(f.gateway.inspect(account, signal())).rejects.toThrow(
    'OpenAI provider binding changed',
  );
  expect(f.run.mock.calls.some(([args]) => args.includes('--credential'))).toBe(false);
});
it('pins the gateway write to the journaled version and rejects a concurrent update', async () => {
  const f = gatewayFixture();
  f.raceUpdate();
  await expect(f.gateway.replace(account, 'PRIVATE_KEY', '10', signal())).rejects.toThrow(
    'could not be confirmed',
  );
  expect(f.api.replace).toHaveBeenCalledTimes(1);
  expect(f.api.replace).toHaveBeenCalledWith(account, 'PRIVATE_KEY', '10', expect.any(AbortSignal));
});
it('normalizes OpenShell omitted false policy defaults but rejects enabled or malformed safety flags', async () => {
  for (const flag of ['request_body_credential_rewrite', 'allow_uninspected_credentials']) {
    const exported = profile();
    const endpoints = exported.endpoints as Record<string, unknown>[];
    delete endpoints[0][flag];
    const f = gatewayFixture();
    f.setPolicy(exported);
    expect(await f.gateway.inspect(account, signal())).toEqual({ version: '10' });
    for (const unsafe of [true, null, 'false']) {
      endpoints[0][flag] = unsafe;
      await expect(f.gateway.inspect(account, signal())).rejects.toThrow(
        'OpenAI provider binding changed',
      );
    }
  }
});

it('rejects differing CLI/API gateway observations before dispatching a credential', async () => {
  const f = gatewayFixture();
  f.driftApi();
  await expect(f.gateway.replace(account, 'PRIVATE_KEY', '10', signal())).rejects.toThrow(
    'OpenAI provider binding changed',
  );
  expect(f.api.replace).not.toHaveBeenCalled();
});
