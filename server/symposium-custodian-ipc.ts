import {
  controllerPublicationApproval,
  serveControllerPublicationApproval,
} from './symposium-custodian-publication.js';
import { decodeCustodianRequest } from './symposium-custodian-protocol.js';
import type { EventEmitter } from 'node:events';
import { z } from 'zod';
import type { CustodianClient } from './symposium-custodian-proxy.js';
import type {
  SymposiumCustodianController,
  CustodianResponse,
} from './symposium-custodian-controller.js';
/** Constructor source compatibility, not an authorization token. */
export const CUSTODIAN_BEFORE_READY_PROTOCOL_VERSION = 1;
export interface CustodianChannel extends Pick<EventEmitter, 'on' | 'off' | 'once'> {
  connected?: boolean;
  send(message: unknown, callback?: (error: Error | null) => void): boolean;
}
export function validateCustodianMode(
  value: string | undefined,
  connected: boolean,
  send: unknown,
) {
  if (value === undefined) return false;
  if (value !== '1') throw Error('Invalid Symposium controller mode');
  if (!connected || typeof send !== 'function')
    throw Error('Symposium controller requires inherited IPC');
  return true;
}
const response = z.strictObject({
  kind: z.literal('response'),
  requestId: z.string().max(200),
  result: z
    .strictObject({ status: z.number().int().min(100).max(599), body: z.unknown() })
    .optional(),
  failed: z.literal(true).optional(),
});
const ready = z.strictObject({ kind: z.literal('ready'), epoch: z.number().int().positive() });
export function createCustodianIpcClient(
  channel: CustodianChannel,
  options: {
    heartbeatMs?: number;
    requestTimeoutMs?: number;
    startupTimeoutMs?: number;
    onEvent?: (sessionId: string, event: Record<string, unknown>) => void;
  } = {},
): CustodianClient {
  const startupTimeoutMs = options.startupTimeoutMs ?? 5000;
  if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1 || startupTimeoutMs > 120000)
    throw Error('Bounded original custodian startup timeout required');
  let epoch: number | undefined;
  let closed = false;
  const pending = new Map<
    string,
    {
      resolve: (value: CustodianResponse) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      closeApproval(): void;
    }
  >();
  let startResolve!: () => void, startReject!: (error: Error) => void;
  const started = new Promise<void>((resolve, reject) => {
    startResolve = resolve;
    startReject = reject;
  });
  void started.catch(() => {});
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(startTimer);
    channel.off('message', message);
    const error = Error('Custodian channel unavailable');
    startReject(error);
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.closeApproval();
      item.reject(error);
    }
    pending.clear();
  };
  const send = (value: unknown) => {
    if (closed) throw Error('Custodian channel unavailable');
    try {
      channel.send(value, (error) => {
        if (error) close();
      });
    } catch {
      close();
      throw Error('Custodian channel unavailable');
    }
  };
  const message = (value: unknown) => {
    if (value && typeof value === 'object') {
      const frame = value as Record<string, unknown>;
      if (
        frame.kind === 'event' &&
        typeof frame.sessionId === 'string' &&
        frame.event &&
        typeof frame.event === 'object' &&
        !Array.isArray(frame.event) &&
        Buffer.byteLength(JSON.stringify(frame)) <= 1_048_576
      ) {
        options.onEvent?.(frame.sessionId, frame.event as Record<string, unknown>);
        return;
      }
    }
    const greeting = ready.safeParse(value);
    if (greeting.success) {
      if (epoch !== undefined && epoch !== greeting.data.epoch) {
        close();
        return;
      }
      epoch = greeting.data.epoch;
      clearTimeout(startTimer);
      startResolve();
      return;
    }
    const parsed = response.safeParse(value);
    if (!parsed.success) return;
    const item = pending.get(parsed.data.requestId);
    if (!item) return;
    pending.delete(parsed.data.requestId);
    clearTimeout(item.timer);
    item.closeApproval();
    if (parsed.data.result && !parsed.data.failed) item.resolve(parsed.data.result);
    else item.reject(Error('Custodian operation unavailable; inspect retained status'));
  };
  channel.on('message', message);
  channel.once('disconnect', close);
  channel.once('error', close);
  const heartbeat = setInterval(() => {
    if (epoch && !closed) send({ kind: 'heartbeat', epoch });
  }, options.heartbeatMs ?? 2000);
  heartbeat.unref?.();
  const startTimer = setTimeout(close, startupTimeoutMs);
  startTimer.unref?.();
  send({ kind: 'hello' });
  return {
    async request(input, approval, signal) {
      await started;
      signal?.throwIfAborted();
      if (closed || !epoch) throw Error('Custodian channel unavailable');
      if (pending.size >= 64 || pending.has(input.requestId))
        throw Error('Custodian request capacity unavailable');
      return new Promise<CustodianResponse>((resolve, reject) => {
        const removeApproval =
          approval && input.operation === 'publication.publish'
            ? serveControllerPublicationApproval(channel, { ...input, epoch: epoch! }, approval)
            : () => {};
        const inventoryRead = ['personal.list', 'account.catalog'].includes(input.operation);
        const cancelPublication = () => {
          if (['publication.publish', 'publication.recover'].includes(input.operation) && !closed)
            send({ kind: 'publication-request-cancel', epoch, requestId: input.requestId });
        };
        const cancel = () => {
          if (!inventoryRead) return cancelPublication();
          // Cancel the read at both ends; metadata has no durable outcome to reconcile.
          if (!closed) send({ kind: 'read-request-cancel', epoch, requestId: input.requestId });
          const item = pending.get(input.requestId);
          if (!item) return;
          pending.delete(input.requestId);
          clearTimeout(item.timer);
          item.closeApproval();
          item.reject(Error('Custodian read cancelled'));
        };
        const closeApproval = () => {
          removeApproval();
          signal?.removeEventListener('abort', cancel);
        };
        const timer = setTimeout(() => {
          if (inventoryRead) return cancel();
          cancelPublication();
          pending.delete(input.requestId);
          closeApproval();
          reject(Error('Custodian response timed out; operation outcome unknown'));
        }, options.requestTimeoutMs ?? 600_000);
        pending.set(input.requestId, { resolve, reject, timer, closeApproval });
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) {
          cancel();
          if (inventoryRead) return;
        }
        try {
          send({ kind: 'request', command: { ...input, epoch } });
        } catch (error) {
          clearTimeout(timer);
          closeApproval();
          pending.delete(input.requestId);
          reject(error);
        }
      });
    },
    invalidate(jti) {
      if (epoch && !closed) send({ kind: 'invalidate', epoch, jti });
    },
  };
}
/** The caller supplies only the channel of the child it just spawned. */
export function serveCustodianController(
  channel: CustodianChannel,
  controller: SymposiumCustodianController,
  options: {
    heartbeatMs?: number;
    observeReady?: (epoch: number, assertCurrent: () => void) => void;
    /** Awaited original constructor capability; unlike synchronous observation,
     * this explicitly prevents IPC readiness and request dispatch until verified. */
    beforeReady?: (epoch: number, assertCurrent: () => void) => Promise<void>;
    readinessTimeoutMs?: number;
  } = {},
): Promise<void> {
  const observeReady = options.observeReady;
  if (observeReady !== undefined && typeof observeReady !== 'function')
    throw Error('Controller ready observer must be a trusted constructor callback');
  const beforeReady = options.beforeReady;
  const readinessTimeoutMs = options.readinessTimeoutMs ?? 120000;
  if (
    beforeReady !== undefined &&
    (typeof beforeReady !== 'function' ||
      !Number.isSafeInteger(readinessTimeoutMs) ||
      readinessTimeoutMs < 1 ||
      readinessTimeoutMs > 120000)
  )
    throw Error('Bounded original readiness capability required');
  const connection = controller.attach();
  let lost = false,
    observedReady = false,
    readinessPending = false,
    readinessPublished = false,
    lastHeartbeat = Date.now();
  const heartbeatMs = options.heartbeatMs ?? 120_000;
  const publications = new Map<string, AbortController>();
  const reads = new Map<string, AbortController>();
  return new Promise<void>((resolve, reject) => {
    let readinessTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (failure?: Error) => {
      if (lost) return;
      lost = true;
      for (const abort of publications.values()) abort.abort();
      for (const abort of reads.values()) abort.abort();
      clearInterval(timer);
      clearTimeout(readinessTimer);
      channel.off('message', message);
      void connection.lost().then(() => (failure ? reject(failure) : resolve()), reject);
    };
    const send = (value: unknown) => {
      if (lost) return;
      try {
        channel.send(value, (error) => {
          if (error) stop();
        });
      } catch {
        stop();
      }
    };
    const message = (value: unknown) => {
      if (lost || !value || typeof value !== 'object') return;
      const frame = value as Record<string, unknown>;
      if (frame.kind === 'hello' && Object.keys(frame).length === 1) {
        lastHeartbeat = Date.now();
        if (readinessPending) return;
        if (!observedReady && observeReady) {
          observedReady = true;
          try {
            connection.assertCurrent();
            const result: unknown = observeReady(connection.epoch, connection.assertCurrent);
            if (result !== undefined) {
              // Refuse asynchronous observation without leaving its rejection unhandled.
              void Promise.resolve(result).catch(() => {});
              throw Error('Controller observer must be synchronous');
            }
            connection.assertCurrent();
            if (lost || !channel.connected) throw Error('Original channel unavailable');
          } catch {
            stop(Error('Original controller observation failed'));
            return;
          }
        }
        const publish = () => {
          if (lost || channel.connected === false) return;
          try {
            connection.assertCurrent();
            readinessPending = false;
            readinessPublished = true;
            clearTimeout(readinessTimer);
            send({ kind: 'ready', epoch: connection.epoch });
          } catch {
            stop(Error('Original controller readiness failed'));
          }
        };
        if (beforeReady && !readinessPublished) {
          readinessPending = true;
          readinessTimer = setTimeout(
            () => stop(Error('Original controller readiness expired')),
            readinessTimeoutMs,
          );
          try {
            connection.assertCurrent();
            // This handled promise belongs to the connection lifetime. It cannot
            // publish after loss, extend its timeout, or replay the capability.
            Promise.resolve(beforeReady(connection.epoch, connection.assertCurrent)).then(
              publish,
              () => stop(Error('Original controller readiness failed')),
            );
          } catch {
            stop(Error('Original controller readiness failed'));
          }
        } else publish();
        return;
      }
      if (
        frame.kind === 'heartbeat' &&
        frame.epoch === connection.epoch &&
        Object.keys(frame).length === 2
      ) {
        lastHeartbeat = Date.now();
        return;
      }
      if (
        frame.kind === 'invalidate' &&
        frame.epoch === connection.epoch &&
        typeof frame.jti === 'string' &&
        frame.jti.length <= 200 &&
        Object.keys(frame).length === 3
      ) {
        connection.invalidate(frame.jti);
        return;
      }
      if (
        frame.kind === 'publication-request-cancel' &&
        frame.epoch === connection.epoch &&
        typeof frame.requestId === 'string' &&
        Object.keys(frame).length === 3
      ) {
        publications.get(frame.requestId)?.abort();
        return;
      }
      if (
        frame.kind === 'read-request-cancel' &&
        frame.epoch === connection.epoch &&
        typeof frame.requestId === 'string' &&
        frame.requestId.length <= 200 &&
        Object.keys(frame).length === 3
      ) {
        reads.get(frame.requestId)?.abort();
        return;
      }
      if (frame.kind !== 'request' || Object.keys(frame).length !== 2) return;
      if (!readinessPublished) {
        stop(Error('Original controller request preceded verified readiness'));
        return;
      }
      const command = frame.command as Record<string, unknown> | undefined;
      if (!command || typeof command.requestId !== 'string' || command.requestId.length > 200)
        return;
      let parsed;
      try {
        parsed = decodeCustodianRequest(command);
      } catch {
        send({ kind: 'response', requestId: command.requestId, failed: true });
        return;
      }
      if (publications.has(parsed.requestId) || reads.has(parsed.requestId)) {
        send({ kind: 'response', requestId: parsed.requestId, failed: true });
        return;
      }
      const publicationAbort = ['publication.publish', 'publication.recover'].includes(
        parsed.operation,
      )
        ? new AbortController()
        : undefined;
      if (publicationAbort) publications.set(parsed.requestId, publicationAbort);
      const readAbort = ['personal.list', 'account.catalog'].includes(parsed.operation)
        ? new AbortController()
        : undefined;
      if (readAbort) reads.set(parsed.requestId, readAbort);
      void connection
        .request(
          parsed,
          parsed.operation === 'publication.publish'
            ? controllerPublicationApproval(channel, parsed)
            : undefined,
          publicationAbort?.signal ?? readAbort?.signal,
        )
        .then(
          (result) => send({ kind: 'response', requestId: command.requestId, result }),
          () => send({ kind: 'response', requestId: command.requestId, failed: true }),
        )
        .finally(() => {
          publications.delete(parsed.requestId);
          reads.delete(parsed.requestId);
        });
    };
    channel.on('message', message);
    channel.once('disconnect', () => stop());
    channel.once('exit', () => stop());
    channel.once('error', () => stop());
    const timer = setInterval(
      () => {
        if (Date.now() - lastHeartbeat >= heartbeatMs) stop();
      },
      Math.min(heartbeatMs, 1000),
    );
  });
}
