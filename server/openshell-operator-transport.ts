import { Client, credentials, type ClientUnaryCall, type MethodDefinition } from '@grpc/grpc-js';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
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

export class OpenShellOperatorTransport {
  private pinnedConnection: string | undefined;
  constructor(
    private readonly options: {
      home: string;
      gateway: string;
      endpoint?: string;
      workspace: string;
      protocol?: string;
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
    definition: MethodDefinition<object, object>,
    request: object,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
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
          if (error) reject(new Error('Gateway API request failed'));
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
  request(definition: MethodDefinition<object, object>, request: object, signal: AbortSignal) {
    return this.unary(this.connection(), definition, request, signal);
  }
}
