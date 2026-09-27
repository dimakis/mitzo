import type { EventEmitter } from 'node:events';
import { z } from 'zod';
import type { CustodianClient } from './symposium-custodian-proxy.js';
import type {
  SymposiumCustodianController,
  CustodianResponse,
} from './symposium-custodian-controller.js';
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
  options: { heartbeatMs?: number; requestTimeoutMs?: number } = {},
): CustodianClient {
  let epoch: number | undefined;
  let closed = false;
  const pending = new Map<
    string,
    {
      resolve: (value: CustodianResponse) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
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
  const startTimer = setTimeout(close, 5000);
  startTimer.unref?.();
  send({ kind: 'hello' });
  return {
    async request(input) {
      await started;
      if (closed || !epoch) throw Error('Custodian channel unavailable');
      if (pending.size >= 64 || pending.has(input.requestId))
        throw Error('Custodian request capacity unavailable');
      return new Promise<CustodianResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(input.requestId);
          reject(Error('Custodian response timed out; operation outcome unknown'));
        }, options.requestTimeoutMs ?? 600_000);
        pending.set(input.requestId, { resolve, reject, timer });
        try {
          send({ kind: 'request', command: { ...input, epoch } });
        } catch (error) {
          clearTimeout(timer);
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
  options: { heartbeatMs?: number } = {},
): Promise<void> {
  const connection = controller.attach();
  let lost = false,
    lastHeartbeat = Date.now();
  const heartbeatMs = options.heartbeatMs ?? 120_000;
  return new Promise<void>((resolve, reject) => {
    const stop = () => {
      if (lost) return;
      lost = true;
      clearInterval(timer);
      channel.off('message', message);
      void connection.lost().then(resolve, reject);
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
        send({ kind: 'ready', epoch: connection.epoch });
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
      if (frame.kind !== 'request' || Object.keys(frame).length !== 2) return;
      const command = frame.command as Record<string, unknown> | undefined;
      if (!command || typeof command.requestId !== 'string' || command.requestId.length > 200)
        return;
      void connection.request(command).then(
        (result) => send({ kind: 'response', requestId: command.requestId, result }),
        () => send({ kind: 'response', requestId: command.requestId, failed: true }),
      );
    };
    channel.on('message', message);
    channel.once('disconnect', stop);
    channel.once('exit', stop);
    channel.once('error', stop);
    const timer = setInterval(
      () => {
        if (Date.now() - lastHeartbeat >= heartbeatMs) stop();
      },
      Math.min(heartbeatMs, 1000),
    );
  });
}
