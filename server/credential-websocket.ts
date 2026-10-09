import { Agent, type RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import WebSocket from 'ws';
import { z } from 'zod';
import { connectionDnsLookup, isAllowedConnectionAddress } from './credential-http.js';

export const MAX_WEBSOCKET_RESPONSE_BYTES = 256 * 1024;
const field = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
  .refine((v) => !['__proto__', 'constructor', 'prototype'].includes(v));
export const WebSocketMatchSchema = z
  .object({
    field,
    equals: z.union([z.string().max(256), z.number().finite().safe(), z.boolean(), z.null()]),
  })
  .strict();
const authMessage = z
  .string()
  .max(4096)
  .refine((text) => {
    try {
      const value = JSON.parse(text);
      return (
        value &&
        !Array.isArray(value) &&
        typeof value === 'object' &&
        Object.keys(value).length <= 16 &&
        Object.entries(value).every(
          ([key, v]) =>
            field.safeParse(key).success &&
            !/(token|secret|password|authorization|api.?key)/i.test(key) &&
            (v === null || ['string', 'number', 'boolean'].includes(typeof v)),
        )
      );
    } catch {
      return false;
    }
  }, 'Use a JSON object with non-secret authentication parameters; the credential is injected separately');
export const WebSocketConfigSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(512)
      .regex(/^\/[A-Za-z0-9_/-]*$/)
      .refine((v) => !v.includes('//')),
    protocols: z
      .array(
        z
          .string()
          .min(1)
          .max(128)
          .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/),
      )
      .max(8)
      .refine((v) => new Set(v).size === v.length)
      .optional(),
    authentication: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('headers') }).strict(),
      z
        .object({
          kind: z.literal('json'),
          message: authMessage,
          credentialField: field,
          challenge: WebSocketMatchSchema.optional(),
          success: WebSocketMatchSchema,
        })
        .strict()
        .refine(
          (v) => !Object.hasOwn(JSON.parse(v.message), v.credentialField),
          'Credential field must be injected, not configured',
        ),
    ]),
  })
  .strict();
export type WebSocketConfig = z.infer<typeof WebSocketConfigSchema>;
export const WebSocketRequestSchema = z
  .object({
    message: z
      .string()
      .min(1)
      .max(128 * 1024)
      .refine((v) => Buffer.byteLength(v) <= 128 * 1024),
    responseMatch: WebSocketMatchSchema.optional(),
  })
  .strict();
export type WebSocketRequest = z.infer<typeof WebSocketRequestSchema>;
export class ConnectionWebSocketError extends Error {
  constructor(readonly mayHaveApplied: boolean) {
    super('WebSocket request failed');
  }
}
export type ConnectionSocketOptions = WebSocket.ClientOptions & Pick<RequestOptions, 'lookup'>;
export type ConnectionSocketFactory = (url: URL, options: ConnectionSocketOptions) => WebSocket;
const socketFactory: ConnectionSocketFactory = (url, options) => new WebSocket(url, options);
export interface ConnectionWebSocketInput {
  url: URL;
  headers?: Record<string, string>;
  protocols?: string[];
  allowPrivateNetwork: boolean;
  check(): void;
}
export interface WebSocketExchange {
  /** Authentication frames have no application effect; all other sends may mutate upstream state. */
  send(text: string, application?: boolean): void;
  finish(body: string): void;
  fail(): void;
}
/** Bounded credential-custody transport shared by every service adapter. Never reconnect or replay. */
export function connectionWebSocketExchange(
  input: ConnectionWebSocketInput,
  signal: AbortSignal,
  handlers: {
    open(channel: WebSocketExchange): void;
    message(text: string, channel: WebSocketExchange): void;
  },
  createSocket: ConnectionSocketFactory = socketFactory,
): Promise<string> {
  signal.throwIfAborted();
  input.check();
  const hostname = input.url.hostname.replace(/^\[|\]$/g, '');
  if (
    input.url.protocol !== 'wss:' ||
    input.url.username ||
    input.url.password ||
    input.url.search ||
    input.url.hash ||
    (isIP(hostname) && !isAllowedConnectionAddress(hostname, input.allowPrivateNetwork))
  )
    throw new ConnectionWebSocketError(false);
  return new Promise((resolve, reject) => {
    const agent = new Agent({ keepAlive: false });
    let socket: WebSocket;
    try {
      socket = createSocket(input.url, {
        agent,
        headers: input.headers ?? {},
        protocols: input.protocols,
        rejectUnauthorized: true,
        followRedirects: false,
        perMessageDeflate: false,
        maxPayload: MAX_WEBSOCKET_RESPONSE_BYTES,
        handshakeTimeout: 15_000,
        lookup: connectionDnsLookup(input.allowPrivateNetwork),
      });
    } catch {
      agent.destroy();
      reject(new ConnectionWebSocketError(false));
      return;
    }
    let settled = false;
    let applicationSent = false;
    let receivedBytes = 0;
    let frames = 0;
    const finish = (body?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      socket.removeAllListeners();
      socket.on('error', () => {});
      socket.terminate();
      agent.destroy();
      if (body === undefined) reject(new ConnectionWebSocketError(applicationSent));
      else resolve(body);
    };
    const abort = () => finish();
    const timer = setTimeout(abort, 30_000);
    signal.addEventListener('abort', abort, { once: true });
    const check = () => {
      signal.throwIfAborted();
      input.check();
    };
    const channel: WebSocketExchange = {
      send(text, application = true) {
        if (settled) return;
        check();
        if (Buffer.byteLength(text) > 256 * 1024) throw new Error('Frame too large');
        applicationSent ||= application;
        socket.send(text);
      },
      finish(body) {
        check();
        if (Buffer.byteLength(body) > MAX_WEBSOCKET_RESPONSE_BYTES) abort();
        else finish(body);
      },
      fail: abort,
    };
    socket.on('error', abort);
    socket.on('close', abort);
    socket.on('open', () => {
      try {
        check();
        handlers.open(channel);
      } catch {
        abort();
      }
    });
    socket.on('message', (data, binary) => {
      try {
        check();
        const text = data.toString();
        receivedBytes += Buffer.byteLength(text);
        if (
          binary ||
          Buffer.byteLength(text) > MAX_WEBSOCKET_RESPONSE_BYTES ||
          receivedBytes > MAX_WEBSOCKET_RESPONSE_BYTES * 3 ||
          ++frames > 64
        )
          return abort();
        handlers.message(text, channel);
      } catch {
        abort();
      }
    });
    if (signal.aborted) abort();
  });
}
function matches(text: string, match: z.infer<typeof WebSocketMatchSchema>) {
  try {
    const value = JSON.parse(text);
    return (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.hasOwn(value, match.field) &&
      value[match.field] === match.equals
    );
  } catch {
    return false;
  }
}
export interface WebSocketTransportInput extends ConnectionWebSocketInput {
  token: string;
  config: WebSocketConfig;
  request: WebSocketRequest;
}
export type WebSocketSender = (
  input: WebSocketTransportInput,
  signal: AbortSignal,
) => Promise<string>;
export function websocketRequest(
  input: WebSocketTransportInput,
  signal: AbortSignal,
  createSocket?: ConnectionSocketFactory,
) {
  const config = WebSocketConfigSchema.parse(input.config);
  const request = WebSocketRequestSchema.parse(input.request);
  const auth = config.authentication;
  let stage: 'challenge' | 'auth' | 'response' =
    auth.kind === 'json' ? (auth.challenge ? 'challenge' : 'auth') : 'response';
  const authenticate = (channel: WebSocketExchange) => {
    if (auth.kind !== 'json') return;
    stage = 'auth';
    channel.send(
      JSON.stringify({ ...JSON.parse(auth.message), [auth.credentialField]: input.token }),
      false,
    );
  };
  return connectionWebSocketExchange(
    {
      ...input,
      protocols: config.protocols,
      headers: auth.kind === 'headers' ? input.headers : {},
    },
    signal,
    {
      open(channel) {
        if (auth.kind === 'headers') channel.send(request.message);
        else if (!auth.challenge) authenticate(channel);
      },
      message(text, channel) {
        if (stage === 'challenge' && auth.kind === 'json') {
          if (!matches(text, auth.challenge!)) return channel.fail();
          authenticate(channel);
        } else if (stage === 'auth' && auth.kind === 'json') {
          if (!matches(text, auth.success)) return channel.fail();
          stage = 'response';
          channel.send(request.message);
        } else if (!request.responseMatch || matches(text, request.responseMatch))
          channel.finish(text);
      },
    },
    createSocket,
  );
}
