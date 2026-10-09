import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { redactCredentialResponse } from './credential-redaction.js';
import { isAllowedConnectionAddress } from './credential-http.js';
import {
  connectionWebSocketExchange,
  type ConnectionSocketOptions,
  type ConnectionSocketFactory,
  type WebSocketExchange,
} from './credential-websocket.js';

export const DashboardAccessSchema = z.enum(['disabled', 'read', 'read-write']);
export type DashboardAccess = z.infer<typeof DashboardAccessSchema>;
const MAX_CONFIG_BYTES = 128 * 1024;
export const MAX_DASHBOARD_RESPONSE_BYTES = 256 * 1024;
export const DashboardRequestSchema = z
  .object({
    operation: z.enum(['list', 'read', 'save']),
    urlPath: z
      .string()
      .max(128)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional(),
    config: z.string().min(1).max(MAX_CONFIG_BYTES).optional(),
    expectedConfigHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();
export type DashboardRequest = z.infer<typeof DashboardRequestSchema>;
export class DashboardRequestError extends Error {
  constructor(
    readonly code:
      | 'DASHBOARD_CHANGED'
      | 'DASHBOARD_SAVE_UNCONFIRMED'
      | 'DASHBOARD_REQUEST_FAILED'
      | 'DASHBOARD_REDACTED',
  ) {
    super(code);
  }
}

function canonical(value: unknown, depth = 0): string {
  if (depth > 64) throw new Error('Dashboard configuration is too deeply nested');
  if (
    typeof value === 'number' &&
    (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
  )
    throw new Error('Dashboard numbers must be safely representable');
  if (Array.isArray(value)) return '[' + value.map((v) => canonical(v, depth + 1)).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k], depth + 1),
        )
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}
export function dashboardConfigHash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export function validateDashboardRequest(input: unknown): DashboardRequest {
  const request = DashboardRequestSchema.parse(input);
  if (request.operation === 'list' && request.urlPath !== undefined)
    throw new Error('List does not accept a dashboard path');
  if (request.operation === 'save') {
    if (!request.config || !request.expectedConfigHash)
      throw new Error('Read the dashboard before saving');
    if (Buffer.byteLength(request.config) > MAX_CONFIG_BYTES)
      throw new Error('Dashboard configuration is too large');
    const config = JSON.parse(request.config);
    if (!config || Array.isArray(config) || typeof config !== 'object')
      throw new Error('Dashboard configuration must be a JSON object');
    dashboardConfigHash(config);
  } else if (request.config !== undefined || request.expectedConfigHash !== undefined) {
    throw new Error('Read operations cannot carry configuration');
  }
  return request;
}
export interface DashboardTransportInput {
  url: URL;
  token: string;
  allowPrivateNetwork: boolean;
  request: DashboardRequest;
  /** Recheck exact session ownership, scope and connection revision before every frame. */
  check(): void;
}
export type DashboardSender = (
  input: DashboardTransportInput,
  signal: AbortSignal,
) => Promise<string>;
export type DashboardSocketOptions = ConnectionSocketOptions;
export type DashboardSocketFactory = ConnectionSocketFactory;

/** One authenticated exchange. Never reconnects, subscribes, or forwards arbitrary HA commands. */
export const sendDashboardRequest: DashboardSender = (input, signal) =>
  dashboardExchange(input, signal);
export function dashboardExchange(
  input: DashboardTransportInput,
  signal: AbortSignal,
  createSocket?: DashboardSocketFactory,
): Promise<string> {
  signal.throwIfAborted();
  input.check();
  const request = validateDashboardRequest(input.request);
  const hostname = input.url.hostname.replace(/^\[|\]$/g, '');
  if (
    input.url.protocol !== 'wss:' ||
    input.url.pathname !== '/api/websocket' ||
    input.url.username ||
    input.url.password ||
    input.url.search ||
    input.url.hash ||
    (isIP(hostname) && !isAllowedConnectionAddress(hostname, input.allowPrivateNetwork))
  )
    throw new Error('Dashboard destination is unavailable');
  let writeSent = false;
  let stage: 'auth-required' | 'auth-ok' | 'list' | 'read' | 'baseline' | 'save' | 'verify' =
    'auth-required';
  let commandId = 0;
  const target = request.urlPath === undefined ? {} : { url_path: request.urlPath };
  const desired = request.operation === 'save' ? JSON.parse(request.config!) : undefined;
  let failureCode: DashboardRequestError['code'] = 'DASHBOARD_REQUEST_FAILED';
  let channel: WebSocketExchange;
  return connectionWebSocketExchange(
    input,
    signal,
    {
      open() {},
      message(body, currentChannel) {
        channel = currentChannel;
        const finish = (body?: string, code?: DashboardRequestError['code']) => {
          if (code) {
            failureCode = code;
            channel.fail();
          } else channel.finish(body!);
        };
        const abort = () => finish(undefined, 'DASHBOARD_REQUEST_FAILED');
        const check = () => {
          signal.throwIfAborted();
          input.check();
        };
        const read = () =>
          channel.send(
            JSON.stringify({ id: ++commandId, type: 'lovelace/config', force: true, ...target }),
          );
        try {
          check();
          const message = JSON.parse(body);
          if (!message || Array.isArray(message) || typeof message !== 'object') return abort();
          if (stage === 'auth-required') {
            if (message.type !== 'auth_required') return abort();
            stage = 'auth-ok';
            channel.send(JSON.stringify({ type: 'auth', access_token: input.token }), false);
            return;
          }
          if (stage === 'auth-ok') {
            if (message.type !== 'auth_ok') return abort();
            if (request.operation === 'list') {
              stage = 'list';
              channel.send(JSON.stringify({ id: ++commandId, type: 'lovelace/dashboards/list' }));
            } else {
              stage = request.operation === 'save' ? 'baseline' : 'read';
              read();
            }
            return;
          }
          if (message.type !== 'result' || message.id !== commandId || message.success !== true)
            return abort();
          if (stage === 'list') {
            if (!Array.isArray(message.result)) return abort();
            finish(JSON.stringify({ operation: 'list', dashboards: message.result }));
          } else if (stage === 'read' || stage === 'baseline' || stage === 'verify') {
            const config = message.result;
            if (!config || Array.isArray(config) || typeof config !== 'object') return abort();
            const configHash = dashboardConfigHash(config);
            if (stage === 'read') {
              finish(
                JSON.stringify({
                  operation: 'read',
                  urlPath: request.urlPath ?? null,
                  config,
                  configHash,
                }),
              );
            } else if (stage === 'baseline') {
              const original = JSON.stringify(config);
              if (
                redactCredentialResponse(original, input.token, {
                  Authorization: `Bearer ${input.token}`,
                }) !== original
              )
                return finish(undefined, 'DASHBOARD_REDACTED');
              if (configHash !== request.expectedConfigHash)
                return finish(undefined, 'DASHBOARD_CHANGED');
              check();
              stage = 'save';
              writeSent = true;
              channel.send(
                JSON.stringify({
                  id: ++commandId,
                  type: 'lovelace/config/save',
                  config: desired,
                  ...target,
                }),
              );
            } else {
              if (configHash !== dashboardConfigHash(desired)) return abort();
              finish(
                JSON.stringify({
                  operation: 'save',
                  urlPath: request.urlPath ?? null,
                  configHash,
                  verified: true,
                }),
              );
            }
          } else if (stage === 'save') {
            check();
            stage = 'verify';
            read();
          }
        } catch {
          abort();
        }
      },
    },
    createSocket,
  ).catch(() => {
    throw new DashboardRequestError(writeSent ? 'DASHBOARD_SAVE_UNCONFIRMED' : failureCode);
  });
}
