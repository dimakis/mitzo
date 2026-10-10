import { Client, credentials, type ClientUnaryCall } from '@grpc/grpc-js';
import { fromJSON, type ServiceDefinition } from '@grpc/proto-loader';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { TerminalSessionMissing } from './terminal-errors.js';
// Independent narrow SSH contract from the reviewed OpenShell v1 source.
// Keeping this client separate preserves enrolled credential-mutation qualification.
const terminalSshService = fromJSON(
  {
    nested: {
      openshell: {
        nested: {
          v1: {
            nested: {
              CreateSshSessionRequest: { fields: { sandbox_id: { type: 'string', id: 1 } } },
              CreateSshSessionResponse: {
                fields: {
                  sandbox_id: { type: 'string', id: 1 },
                  token: { type: 'string', id: 2 },
                  gateway_host: { type: 'string', id: 3 },
                  gateway_port: { type: 'uint32', id: 4 },
                  gateway_scheme: { type: 'string', id: 5 },
                  host_key_fingerprint: { type: 'string', id: 7 },
                  expires_at_ms: { type: 'int64', id: 8 },
                },
              },
              OpenShell: {
                methods: {
                  CreateSshSession: {
                    comment: 'Mint a terminal grant for an immutable physical ID.',
                    requestType: 'CreateSshSessionRequest',
                    responseType: 'CreateSshSessionResponse',
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  { keepCase: true, longs: String, defaults: false },
)['openshell.v1.OpenShell'] as ServiceDefinition;
type Connection = { endpoint: string; ca: Buffer; cert: Buffer; key: Buffer };
function endpoint(value: string) {
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== '/'
  )
    throw new Error();
  return parsed.origin;
}
/** Read only the registered controller files. Never export authentication or error bodies. */
function privateFile(path: string, key = false) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > 256 * 1024 ||
      (before.uid !== process.getuid?.() && before.uid !== 0) ||
      before.mode & 0o022 ||
      (key && before.mode & 0o077)
    )
      throw new Error();
    const value = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      value.length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error();
    return value;
  } finally {
    closeSync(fd);
  }
}

/** Authenticated, physical-ID SSH bootstrap; exposes no provider mutation or discovery. */
export class TerminalSshApi {
  private pinnedConnection: string | undefined;
  constructor(
    private readonly options: {
      home: string;
      gateway: string;
      endpoint?: string;
      workspace: string;
      protocol: 'openshell-v1';
    },
  ) {}
  private connection(): Connection {
    if (
      this.options.protocol !== 'openshell-v1' ||
      !isAbsolute(this.options.home) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(this.options.gateway) ||
      !this.options.workspace
    )
      throw new Error();
    const root = join(this.options.home, '.config', 'openshell', 'gateways', this.options.gateway);
    const metadata = z
      .object({
        name: z.string(),
        gateway_endpoint: z.string(),
        auth_mode: z.string().nullable().optional(),
      })
      .parse(JSON.parse(privateFile(join(root, 'metadata.json')).toString('utf8')));
    if (
      metadata.name !== this.options.gateway ||
      (metadata.auth_mode && metadata.auth_mode !== 'mtls')
    )
      throw new Error();
    const selected = endpoint(metadata.gateway_endpoint);
    if (this.options.endpoint && endpoint(this.options.endpoint) !== selected) throw new Error();
    const result = {
      endpoint: selected,
      ca: privateFile(join(root, 'mtls', 'ca.crt')),
      cert: privateFile(join(root, 'mtls', 'tls.crt')),
      key: privateFile(join(root, 'mtls', 'tls.key'), true),
    };
    const cert = new X509Certificate(result.cert);
    if (
      !cert.checkPrivateKey(createPrivateKey(result.key)) ||
      Date.parse(cert.validFrom) > Date.now() ||
      Date.parse(cert.validTo) <= Date.now()
    )
      throw new Error();
    const identity = createHash('sha256')
      .update(selected)
      .update(result.ca)
      .update(result.cert)
      .update(result.key)
      .digest('hex');
    if (this.pinnedConnection && this.pinnedConnection !== identity) throw new Error();
    this.pinnedConnection = identity;
    return result;
  }
  private async unary(
    connection: Connection,
    method: 'CreateSshSession',
    request: object,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    const definition = terminalSshService[method];
    const client = new Client(
      new URL(connection.endpoint).host,
      credentials.createSsl(connection.ca, connection.key, connection.cert),
      {
        'grpc.enable_retries': 0,
        'grpc.max_receive_message_length': 65536,
        'grpc.max_send_message_length': 32768,
      },
    );
    try {
      return await new Promise((resolve, reject) => {
        const active: { call?: ClientUnaryCall } = {};
        let done = false;
        const finish = (error: unknown, value?: unknown) => {
          if (done) return;
          done = true;
          signal.removeEventListener('abort', cancel);
          if (error && typeof error === 'object' && 'code' in error && error.code === 5)
            reject(new TerminalSessionMissing());
          else if (error) reject(new Error('Gateway API request failed'));
          else resolve(value);
        };
        const cancel = () => {
          active.call?.cancel();
          finish(new Error());
        };
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) {
          cancel();
          return;
        }
        try {
          active.call = client.makeUnaryRequest(
            definition.path,
            definition.requestSerialize,
            definition.responseDeserialize,
            request,
            { deadline: Date.now() + 30000 },
            finish,
          );
        } catch (error) {
          finish(error);
        }
      });
    } finally {
      client.close();
    }
  }
  /** The gateway mints a short-lived grant for the persisted physical ID, never a name. */
  async createTerminalSsh(sandboxId: string, signal: AbortSignal) {
    try {
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(sandboxId)) throw Error();
      const connection = this.connection();
      const grant = z
        .object({
          sandbox_id: z.literal(sandboxId),
          token: z
            .string()
            .min(1)
            .max(4096)
            .regex(/^[A-Za-z0-9._~+/=-]+$/),
          gateway_host: z
            .string()
            .min(1)
            .max(253)
            .regex(/^[A-Za-z0-9.:[\]_-]+$/),
          gateway_port: z.number().int().min(1).max(65535),
          gateway_scheme: z.literal('https'),
          expires_at_ms: z.string().regex(/^[0-9]+$/),
        })
        .parse(await this.unary(connection, 'CreateSshSession', { sandbox_id: sandboxId }, signal));
      const origin = new URL(
        `${grant.gateway_scheme}://${grant.gateway_host}:${grant.gateway_port}`,
      ).origin;
      if (origin !== connection.endpoint || Number(grant.expires_at_ms) <= Date.now())
        throw Error();
      return { sandboxId, token: grant.token, proxyUrl: `${origin}/proxy/connect` };
    } catch (error) {
      if (error instanceof TerminalSessionMissing) throw error;
      // Gateway/transport diagnostics must not retain credentials or grant material.
      // eslint-disable-next-line preserve-caught-error
      throw Error('Terminal SSH identity unavailable');
    }
  }
}
