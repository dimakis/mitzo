import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { load } from 'js-yaml';
import {
  KEYCHAIN_ROTATION_HELPER,
  KeychainRotationCredentials,
} from '../keychain-rotation-credentials.js';
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
  it('invalidates its recovery marker when an operator changes only the saved secret', () => {
    const version = '890456d2-8b5d-43d6-b8b8-48c1c99837c0';
    const marker = `mitzo-openai-key-v1:${version}:${createHash('sha256').update('original-key').digest('hex')}`;
    const script = `import ast,json,sys,hashlib,hmac,uuid
request=json.load(sys.stdin)
tree=ast.parse(request['program'])
fn=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='marker_version')
exec(compile(ast.Module(body=[fn],type_ignores=[]),'<marker-check>','exec'))
print(json.dumps([marker_version(request['marker'].encode(),value.encode()) for value in ['original-key','changed-key']]))`;
    const result = spawnSync('/usr/bin/python3', ['-I', '-c', script], {
      input: JSON.stringify({ program: KEYCHAIN_ROTATION_HELPER, marker }),
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([version, null]);
  });
  it('uses stdin for the key and writes an atomic version marker rather than secret argv', async () => {
    const run = vi.fn(async () => '{"ok":true}');
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
  const run = vi.fn(async (args: readonly string[], _options: unknown) => {
    if (args[1] === 'profile') return JSON.stringify(policy);
    if (args[1] === 'update') {
      version++;
      return '';
    }
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
    stopSandbox: vi.fn(async () => {}),
    sandboxStopped: vi.fn(async () => true),
  };
  const gateway = new OpenShellOpenAIKeyGateway(run, 'default', sandboxes);
  return {
    gateway,
    run,
    sandboxes,
    driftId: () => {
      providerId = 'wrong-id';
    },
    driftPolicy: () => {
      policy = { ...policy, binaries: ['/usr/bin/sh'] };
    },
  };
}
describe('OpenShell OpenAI credential adapter', () => {
  it('pins provider identity and policy, stops retained workloads, and passes only a key name in argv', async () => {
    const f = gatewayFixture();
    expect(await f.gateway.inspect(account, signal())).toEqual({ version: '10' });
    await f.gateway.pause(account, signal());
    expect(f.sandboxes.stopSandbox).toHaveBeenCalledWith('retained-chat', expect.any(AbortSignal));
    expect(await f.gateway.replace(account, 'PRIVATE_KEY', signal())).toEqual({ version: '11' });
    const update = f.run.mock.calls.find(([args]) => args[1] === 'update')!;
    expect(update[0]).toEqual([
      'provider',
      'update',
      'work-api',
      '--workspace',
      'default',
      '--credential',
      'OPENAI_API_KEY',
    ]);
    expect(update[1]).toMatchObject({ env: { OPENAI_API_KEY: 'PRIVATE_KEY' } });
    expect(JSON.stringify(update[0])).not.toContain('PRIVATE_KEY');
  });
  it('refuses provider substitution and policy changes before credentials are submitted', async () => {
    for (const drift of ['driftId', 'driftPolicy'] as const) {
      const f = gatewayFixture();
      f[drift]();
      await expect(f.gateway.replace(account, 'PRIVATE_KEY', signal())).rejects.toThrow(
        'OpenAI provider binding changed',
      );
      expect(f.run.mock.calls.some(([args]) => args[1] === 'update')).toBe(false);
    }
  });
  it('refuses credential replacement when a retained sandbox cannot be confirmed stopped', async () => {
    const f = gatewayFixture();
    f.sandboxes.sandboxStopped.mockResolvedValueOnce(false);
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
