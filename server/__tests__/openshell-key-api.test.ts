import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  Server,
  ServerCredentials,
  status,
  type ServerUnaryCall,
  type sendUnaryData,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { OpenShellProviderKeyApi } from '../openshell-key-api.js';

// Independent v1 wire fixture from OpenShell b4c459f92446167afcb0a2dcf7d9fa6c8945e59c.
const proto = `syntax="proto3"; package openshell.v1;
message Meta {string id=1; string name=2; uint64 resource_version=5; string workspace=7;}
message Provider {Meta metadata=1; string type=2; map<string,string> credentials=3; string profile_workspace=6;}
message GetProviderRequest {string name=1; string workspace=2;}
message UpdateProviderRequest {Provider provider=1; string workspace=3;}
message ProviderResponse {Provider provider=1;}
message CreateSshSessionRequest {string sandbox_id=1;}
message CreateSshSessionResponse {string sandbox_id=1;string token=2;string gateway_host=3;uint32 gateway_port=4;string gateway_scheme=5;string host_key_fingerprint=7;int64 expires_at_ms=8;}
service OpenShell {rpc CreateSshSession(CreateSshSessionRequest) returns(CreateSshSessionResponse);rpc GetProvider(GetProviderRequest) returns(ProviderResponse); rpc UpdateProvider(UpdateProviderRequest) returns(ProviderResponse);}`;
const account = {
  id: 'work',
  label: 'Work',
  providerName: 'work-api',
  providerId: 'provider-id',
  credentialRef: { provider: 'keychain', service: 'synthetic', account: 'work' },
};
const signal = () => AbortSignal.timeout(5000);
let directory: string;
let home: string;
let endpoint: string;
let server: Server;
let version = '10';
let saved = 'OLD_SYNTHETIC_KEY';
let race = false;
let wrongId = false;
let secretError = false;
let wrongAcknowledgement = false;
let hang = false;
let seen: object[];
const response = () => ({
  provider: {
    metadata: {
      id: wrongId ? 'other-id' : account.providerId,
      name: account.providerName,
      workspace: 'default',
      resource_version: version,
    },
    type: 'mitzo-openai-keychain-spike',
    credentials: { OPENAI_API_KEY: '[REDACTED]' },
  },
});
const api = (overrides = {}) =>
  new OpenShellProviderKeyApi({
    home,
    gateway: 'synthetic',
    endpoint,
    workspace: 'default',
    protocol: 'openshell-v1',
    ...overrides,
  });
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'mitzo-key-rpc-'));
  home = join(directory, 'home');
  const tls = join(home, '.config/openshell/gateways/synthetic/mtls');
  mkdirSync(tls, { recursive: true, mode: 0o700 });
  const openssl = (args: string[]) =>
    execFileSync('openssl', args, { cwd: directory, stdio: 'ignore' });
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'ca.key',
    '-out',
    'ca.crt',
    '-subj',
    '/CN=Synthetic CA',
    '-days',
    '2',
  ]);
  for (const name of ['client', 'server']) {
    openssl([
      'req',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      `${name}.key`,
      '-out',
      `${name}.csr`,
      '-subj',
      `/CN=${name}`,
    ]);
    writeFileSync(
      join(directory, 'extensions'),
      `subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=${name === 'server' ? 'serverAuth' : 'clientAuth'}\n`,
    );
    openssl([
      'x509',
      '-req',
      '-in',
      `${name}.csr`,
      '-CA',
      'ca.crt',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      `${name}.crt`,
      '-days',
      '1',
      '-extfile',
      'extensions',
    ]);
  }
  for (const [target, source] of [
    ['ca.crt', 'ca.crt'],
    ['tls.crt', 'client.crt'],
    ['tls.key', 'client.key'],
  ])
    writeFileSync(join(tls, target), readFileSync(join(directory, source)), { mode: 0o600 });
  writeFileSync(join(directory, 'contract.proto'), proto);
  const definition = loadSync(join(directory, 'contract.proto'), { keepCase: true, longs: String });
  server = new Server();
  server.addService(definition['openshell.v1.OpenShell'] as Parameters<Server['addService']>[0], {
    CreateSshSession(
      call: ServerUnaryCall<{ sandbox_id: string }, object>,
      callback: sendUnaryData<object>,
    ) {
      seen.push(call.request);
      const gateway = new URL(endpoint);
      callback(null, {
        sandbox_id: wrongId ? 'replacement' : call.request.sandbox_id,
        token: 'EPHEMERAL_SYNTHETIC_TOKEN',
        gateway_host: gateway.hostname,
        gateway_port: Number(gateway.port),
        gateway_scheme: 'https',
        expires_at_ms: String(Date.now() + 60000),
      });
    },
    GetProvider(
      call: ServerUnaryCall<{ name: string; workspace: string }, object>,
      callback: sendUnaryData<object>,
    ) {
      expect(call.request).toMatchObject({ name: account.providerName, workspace: 'default' });
      if (hang) return;
      callback(null, response());
    },
    UpdateProvider(
      call: ServerUnaryCall<
        {
          provider: { metadata: { resource_version: string }; credentials: Record<string, string> };
          workspace: string;
        },
        object
      >,
      callback: sendUnaryData<object>,
    ) {
      seen.push(call.request);
      if (secretError)
        return callback({ code: status.UNAVAILABLE, details: 'NEW_SYNTHETIC_KEY leaked upstream' });
      if (race) version = '11';
      if (call.request.provider.metadata.resource_version !== version)
        return callback({ code: status.ABORTED, details: 'version conflict' });
      saved = call.request.provider.credentials.OPENAI_API_KEY;
      version = String(BigInt(version) + 1n);
      if (wrongAcknowledgement) version = '12';
      callback(null, response());
    },
  });
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync(
      '127.0.0.1:0',
      ServerCredentials.createSsl(
        readFileSync(join(directory, 'ca.crt')),
        [
          {
            cert_chain: readFileSync(join(directory, 'server.crt')),
            private_key: readFileSync(join(directory, 'server.key')),
          },
        ],
        true,
      ),
      (error, value) => (error ? reject(error) : resolve(value)),
    ),
  );
  endpoint = `https://127.0.0.1:${port}`;
}, 20000);
beforeEach(() => {
  version = '10';
  saved = 'OLD_SYNTHETIC_KEY';
  race = false;
  wrongId = false;
  secretError = false;
  wrongAcknowledgement = false;
  hang = false;
  seen = [];
  writeFileSync(
    join(home, '.config/openshell/gateways/synthetic/metadata.json'),
    JSON.stringify({ name: 'synthetic', gateway_endpoint: endpoint, auth_mode: 'mtls' }),
    { mode: 0o600 },
  );
});
afterAll(() => {
  server?.forceShutdown();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

it('uses existing mTLS and the pinned v1 wire contract to condition one credential update', async () => {
  const client = api();
  expect(await client.inspect(account, signal())).toEqual({ version: '10' });
  expect(await client.replace(account, 'NEW_SYNTHETIC_KEY', '10', signal())).toEqual({
    version: '11',
  });
  expect(seen).toEqual([
    {
      workspace: 'default',
      provider: {
        metadata: {
          id: account.providerId,
          name: account.providerName,
          resource_version: '10',
          workspace: 'default',
        },
        type: 'mitzo-openai-keychain-spike',
        profile_workspace: '',
        credentials: { OPENAI_API_KEY: 'NEW_SYNTHETIC_KEY' },
      },
    },
  ]);
  expect(saved).toBe('NEW_SYNTHETIC_KEY');
});
it('does not overwrite a concurrent gateway update or retry against a newer version', async () => {
  race = true;
  await expect(api().replace(account, 'NEW_SYNTHETIC_KEY', '10', signal())).rejects.toThrow(
    /^OpenAI gateway API update could not be confirmed$/,
  );
  expect(saved).toBe('OLD_SYNTHETIC_KEY');
  expect(seen).toHaveLength(1);
});
it('checks provider identity before handing over a replacement and redacts upstream errors', async () => {
  wrongId = true;
  await expect(api().inspect(account, signal())).rejects.toThrow(
    /^OpenAI gateway API is unavailable$/,
  );
  expect(seen).toHaveLength(0);
  wrongId = false;
  secretError = true;
  await expect(api().replace(account, 'NEW_SYNTHETIC_KEY', '10', signal())).rejects.toThrow(
    /^OpenAI gateway API update could not be confirmed$/,
  );
});
it('refuses missing protocol enrollment, mismatched destinations, unsupported auth, and insecure endpoints', async () => {
  for (const overrides of [
    { protocol: undefined },
    { endpoint: 'https://other.invalid' },
    { endpoint: 'http://127.0.0.1' },
    { gateway: '../synthetic' },
  ])
    await expect(api(overrides).inspect(account, signal())).rejects.toThrow(
      /^OpenAI gateway API is unavailable$/,
    );
  writeFileSync(
    join(home, '.config/openshell/gateways/synthetic/metadata.json'),
    JSON.stringify({ name: 'synthetic', gateway_endpoint: endpoint, auth_mode: 'oidc' }),
  );
  await expect(api().inspect(account, signal())).rejects.toThrow(
    /^OpenAI gateway API is unavailable$/,
  );
  expect(seen).toHaveLength(0);
});
it('rejects private-key permission drift and gateway alias changes after the read', async () => {
  const client = api();
  await client.inspect(account, signal());
  const key = join(home, '.config/openshell/gateways/synthetic/mtls/tls.key');
  chmodSync(key, 0o644);
  await expect(client.replace(account, 'NEW_SYNTHETIC_KEY', '10', signal())).rejects.toThrow(
    /^OpenAI gateway API update could not be confirmed$/,
  );
  chmodSync(key, 0o600);
  writeFileSync(
    join(home, '.config/openshell/gateways/synthetic/metadata.json'),
    JSON.stringify({
      name: 'synthetic',
      gateway_endpoint: 'https://other.invalid',
      auth_mode: 'mtls',
    }),
  );
  await expect(client.replace(account, 'NEW_SYNTHETIC_KEY', '10', signal())).rejects.toThrow(
    /^OpenAI gateway API update could not be confirmed$/,
  );
  expect(seen).toHaveLength(0);
});

it('does not accept an unproven acknowledgement after a possibly committed update', async () => {
  wrongAcknowledgement = true;
  await expect(api().replace(account, 'NEW_SYNTHETIC_KEY', '10', signal())).rejects.toThrow(
    /^OpenAI gateway API update could not be confirmed$/,
  );
  expect(seen).toHaveLength(1);
});
it('cancels a stalled request without dispatching a credential', async () => {
  hang = true;
  await expect(api().inspect(account, AbortSignal.timeout(100))).rejects.toThrow(
    /^OpenAI gateway API is unavailable$/,
  );
  expect(seen).toHaveLength(0);
});
it('keeps TLS verification enabled when the registered CA does not trust the gateway', async () => {
  const ca = join(home, '.config/openshell/gateways/synthetic/mtls/ca.crt');
  const trusted = readFileSync(ca);
  try {
    writeFileSync(ca, readFileSync(join(directory, 'client.crt')));
    await expect(api().inspect(account, AbortSignal.timeout(1000))).rejects.toThrow(
      /^OpenAI gateway API is unavailable$/,
    );
    expect(seen).toHaveLength(0);
  } finally {
    writeFileSync(ca, trusted);
  }
});

it('mints a terminal SSH grant for an immutable sandbox ID with no name lookup', async () => {
  const grant = await api().createTerminalSsh('original-id', signal());
  expect(seen).toEqual([{ sandbox_id: 'original-id' }]);
  expect(grant).toEqual({
    sandboxId: 'original-id',
    token: 'EPHEMERAL_SYNTHETIC_TOKEN',
    proxyUrl: `${endpoint}/proxy/connect`,
  });
  wrongId = true;
  await expect(api().createTerminalSsh('original-id', signal())).rejects.toThrow();
});
