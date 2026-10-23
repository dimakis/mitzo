import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { connect as tcpConnect, isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { connect as tlsConnect, checkServerIdentity } from 'node:tls';
import type { Duplex } from 'node:stream';
import { z } from 'zod';
import { isAllowedConnectionAddress } from './credential-http.js';
import { validateLanRelayEndpoint } from './secret-relay-lan.js';
const text = z
  .string()
  .min(1)
  .max(1024)
  .refine((s) => !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff\ufffe\uffff]/u.test(s));
const base = z.object({
  adapter: z.literal('mqtt'),
  broker: z.string().min(1).max(512),
  username: text,
  allowPrivateNetwork: z.boolean().default(false),
});
export const MqttRelayTargetSchema = z.discriminatedUnion('operation', [
  base.extend({ operation: z.literal('connect') }).strict(),
  base
    .extend({
      operation: z.literal('publish'),
      topic: text.refine((s) => !/[+#]/.test(s)),
      payload: z.string().max(16384),
      retain: z.boolean().default(false),
    })
    .strict(),
]);
export type MqttRelayTarget = z.infer<typeof MqttRelayTargetSchema>;
export function validateMqttRelayTarget(target: MqttRelayTarget, allowLan: boolean) {
  const {
    endpoint: _endpoint,
    label: _label,
    ...input
  } = target as MqttRelayTarget & { endpoint?: string; label?: string };
  MqttRelayTargetSchema.parse(input);
  const url = new URL(target.broker);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    !['mqtt:', 'mqtts:'].includes(url.protocol) ||
    !url.port ||
    +url.port < 1 ||
    +url.port > 65535 ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname ||
    target.broker !== `${url.protocol}//${url.host}`
  )
    throw new Error('Invalid MQTT broker origin');
  if (url.protocol === 'mqtt:') {
    if (!allowLan) throw new Error('Cleartext MQTT adapter disabled');
    validateLanRelayEndpoint(`http://${url.host}`);
  } else if (isIP(host) && !isAllowedConnectionAddress(host, target.allowPrivateNetwork))
    throw new Error('MQTT destination blocked');
  if (
    Object.values(networkInterfaces())
      .flat()
      .some((i) => i?.address === host)
  )
    throw new Error('MQTT controller destination blocked');
  return url;
}
type Authority = () => Promise<void>;
type Open = (target: MqttRelayTarget, signal: AbortSignal, authority: Authority) => Promise<Duplex>;
/** Resolve once, validate every result, then pin the chosen address. No proxy,
 * redirect, reconnect, resubscription, Will, persistent session or disk store. */
const openMqtt: Open = async (target, signal, authority) => {
  const url = validateMqttRelayTarget(target, true);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true });
  const local = Object.values(networkInterfaces())
    .flat()
    .map((i) => i?.address);
  if (
    !addresses.length ||
    addresses.length > 16 ||
    addresses.some(
      (a) =>
        isIP(a.address) !== a.family ||
        !isAllowedConnectionAddress(
          a.address,
          target.allowPrivateNetwork || url.protocol === 'mqtt:',
        ) ||
        local.includes(a.address),
    )
  )
    throw new Error('MQTT destination blocked');
  await authority();
  return new Promise((resolve, reject) => {
    const options = { host: addresses[0].address, port: +url.port, signal };
    const socket =
      url.protocol === 'mqtts:'
        ? tlsConnect({
            ...options,
            rejectUnauthorized: true,
            servername: isIP(hostname) ? undefined : hostname,
            checkServerIdentity: (_name, cert) => checkServerIdentity(hostname, cert),
          })
        : tcpConnect(options);
    socket.once('error', reject);
    socket.once(url.protocol === 'mqtts:' ? 'secureConnect' : 'connect', () => resolve(socket));
  });
};
function string(value: string) {
  const b = Buffer.from(value);
  if (b.length > 65535) throw new Error('MQTT field too large');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
}
function packet(header: number, ...parts: Buffer[]) {
  const body = Buffer.concat(parts);
  let n = body.length;
  const length: number[] = [];
  do {
    let d = n % 128;
    n = Math.floor(n / 128);
    if (n) d |= 128;
    length.push(d);
  } while (n);
  return Buffer.concat([Buffer.from([header, ...length]), body]);
}
/** A deliberately small MQTT 3.1.1 operation: CONNECT, optional QoS1 PUBLISH,
 * then DISCONNECT. PUBACK confirms broker receipt, not device application.
 * No retries even though MQTT QoS1 normally permits retransmission. */
export async function sendMqttRelayTarget(
  target: MqttRelayTarget,
  password: string,
  signal: AbortSignal,
  check: () => void,
  dispatched: () => void,
  assertCurrent?: () => Promise<void>,
  open: Open = openMqtt,
): Promise<{ acknowledgement: 'connack' | 'puback' }> {
  const authority = async () => {
    await assertCurrent?.();
    signal.throwIfAborted();
    check();
  };
  let stream: Duplex | undefined;
  try {
    await authority();
    stream = await open(target, signal, authority);
    await authority();
    const socket = stream;
    return await new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      let stage: 'connect' | 'publish' | 'publishing' = 'connect';
      let settled = false;
      const fail = () => {
        if (!settled) {
          settled = true;
          reject(new Error('MQTT operation unconfirmed'));
        }
      };
      const abort = () => {
        fail();
        socket.destroy();
      };
      signal.addEventListener('abort', abort, { once: true });
      const success = (acknowledgement: 'connack' | 'puback') => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        socket.end(Buffer.from([0xe0, 0]));
        resolve({ acknowledgement });
      };
      socket.on('error', fail);
      socket.on('end', fail);
      socket.on('close', fail);
      socket.on('data', (chunk: Buffer) => {
        if (settled) return;
        buffer = Buffer.concat([buffer, chunk]);
        // Only CONNACK/PUBACK are legal here; both are exactly four bytes.
        if (buffer.length > 8) return fail();
        if (buffer.length < 4) return;
        const response = buffer.subarray(0, 4);
        buffer = buffer.subarray(4);
        if (stage === 'connect') {
          if (!response.equals(Buffer.from([0x20, 2, 0, 0])) || buffer.length) return fail();
          if (target.operation === 'connect') return success('connack');
          stage = 'publishing';
          void authority().then(() => {
            if (settled) return;
            stage = 'publish';
            socket.write(
              packet(
                target.retain ? 0x33 : 0x32,
                string(target.topic),
                Buffer.from([0, 1]),
                Buffer.from(target.payload),
              ),
            );
          }, fail);
        } else if (
          stage === 'publish' &&
          !buffer.length &&
          response.equals(Buffer.from([0x40, 2, 0, 1]))
        )
          success('puback');
        else fail();
      });
      try {
        signal.throwIfAborted();
        check();
        dispatched();
        socket.write(
          packet(
            0x10,
            string('MQTT'),
            Buffer.from([4, 0xc2, 0, 0]),
            string(`mitzo-${randomUUID()}`),
            string(target.username),
            string(password),
          ),
        );
      } catch {
        fail();
      }
    });
  } catch {
    throw new Error('MQTT operation unconfirmed');
  } finally {
    stream?.destroy();
  }
}
