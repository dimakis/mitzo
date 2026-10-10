import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
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
import { TerminalSshApi } from '../terminal-ssh-api.js';
import { TerminalSessionMissing } from '../terminal-errors.js';

// Independent v1 wire fixture from OpenShell b4c459f92446167afcb0a2dcf7d9fa6c8945e59c.
const proto = `syntax="proto3"; package openshell.v1;
message CreateSshSessionRequest {string sandbox_id=1;}
message CreateSshSessionResponse {string sandbox_id=1;string token=2;string gateway_host=3;uint32 gateway_port=4;string gateway_scheme=5;string host_key_fingerprint=7;int64 expires_at_ms=8;}
service OpenShell {rpc CreateSshSession(CreateSshSessionRequest) returns(CreateSshSessionResponse);}`;
let directory: string;
let home: string;
let endpoint: string;
let server: Server;
let wrongId = false;
let rpcError: number | undefined;
let seen: object[];
const signal = () => AbortSignal.timeout(5000);
const api = (overrides = {}) =>
  new TerminalSshApi({
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
      if (rpcError !== undefined) {
        callback({ code: rpcError, details: 'Synthetic failure' });
        return;
      }
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
  wrongId = false;
  rpcError = undefined;
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
it('recognizes confirmed physical sandbox absence while retaining uncertain transport failures', async () => {
  rpcError = status.NOT_FOUND;
  await expect(api().createTerminalSsh('original-id', signal())).rejects.toBeInstanceOf(
    TerminalSessionMissing,
  );
  rpcError = status.UNAVAILABLE;
  const failure = await api()
    .createTerminalSsh('original-id', signal())
    .catch((error) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toBeInstanceOf(TerminalSessionMissing);
  expect(seen).toEqual([{ sandbox_id: 'original-id' }, { sandbox_id: 'original-id' }]);
});
