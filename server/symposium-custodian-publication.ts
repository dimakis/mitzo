import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  CapabilityApproval,
  CapabilityApprovalRequest,
} from './connections/capabilities/types.js';
import { canonicalJson } from './connections/capabilities/input-validation.js';
import type { CustodianChannel } from './symposium-custodian-ipc.js';
import type { CustodianRequest } from './symposium-custodian-protocol.js';
const id = z.string().min(1).max(200);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const binding = z.strictObject({
  requestId: id,
  epoch: z.number().int().positive(),
  authId: id,
  sessionId: id,
  challengeId: id,
  digest: hash,
});
const capability = z.strictObject({
  capabilityId: id,
  capabilityVersion: z.number().int().positive(),
  connectionId: id,
  operationId: id,
  input: z.record(z.string(), z.union([z.string(), z.boolean()])),
  forcePrompt: z.literal(true),
});
const challenge = binding.extend({ kind: z.literal('publication-approval'), request: capability });
const decision = binding.extend({ kind: z.literal('publication-decision'), allowed: z.boolean() });
const cancellation = binding.extend({ kind: z.literal('publication-cancel') });
const digest = (value: CapabilityApprovalRequest) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
function bounded(value: unknown) {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '') <= 1_048_576;
  } catch {
    return false;
  }
}
function matches(value: z.infer<typeof binding>, command: CustodianRequest) {
  return (
    command.operation === 'publication.publish' &&
    value.requestId === command.requestId &&
    value.epoch === command.epoch &&
    value.authId === command.authorization.id &&
    value.sessionId === command.sessionId &&
    command.authorization.expiresAt > Date.now()
  );
}
/** Transient exchange inside the existing inherited channel; not a grant or credential owner. */
export function controllerPublicationApproval(
  channel: CustodianChannel,
  command: CustodianRequest,
): CapabilityApproval {
  return async (request, signal) => {
    signal.throwIfAborted();
    if (
      command.operation !== 'publication.publish' ||
      !command.sessionId ||
      command.authorization.expiresAt <= Date.now()
    )
      throw Error('Publication controller unavailable');
    const frame = challenge.parse({
      kind: 'publication-approval',
      requestId: command.requestId,
      epoch: command.epoch,
      authId: command.authorization.id,
      sessionId: command.sessionId,
      challengeId: randomUUID(),
      digest: digest(request),
      request,
    });
    if (!bounded(frame)) throw Error('Publication approval too large');
    const identity = binding.parse(
      Object.fromEntries(
        Object.entries(frame).filter(([key]) => key !== 'kind' && key !== 'request'),
      ),
    );
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const finish = (allowed?: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        channel.off('message', message);
        channel.off('disconnect', lost);
        channel.off('exit', lost);
        channel.off('error', lost);
        signal.removeEventListener('abort', lost);
        try {
          channel.send({ ...identity, kind: 'publication-cancel' }, () => {});
        } catch {
          /* Channel loss already denies. */
        }
        if (
          allowed !== undefined &&
          !signal.aborted &&
          command.authorization.expiresAt > Date.now()
        )
          resolve(allowed);
        else reject(Error('Publication approval unavailable'));
      };
      const lost = () => finish();
      const message = (value: unknown) => {
        if (!bounded(value)) return;
        const parsed = decision.safeParse(value);
        if (!parsed.success || parsed.data.challengeId !== frame.challengeId) return;
        const received = parsed.data;
        if (!matches(received, command) || received.digest !== frame.digest) return finish(false);
        finish(received.allowed);
      };
      const timer = setTimeout(
        lost,
        Math.min(300_000, command.authorization.expiresAt - Date.now()),
      );
      channel.on('message', message);
      channel.once('disconnect', lost);
      channel.once('exit', lost);
      channel.once('error', lost);
      signal.addEventListener('abort', lost, { once: true });
      if (signal.aborted) return lost();
      try {
        channel.send(frame, (error) => {
          if (error) lost();
        });
      } catch {
        lost();
      }
    });
  };
}
/** Only a locally authenticated pending publish request may receive an approval prompt. */
export function serveControllerPublicationApproval(
  channel: CustodianChannel,
  command: CustodianRequest,
  approve: CapabilityApproval,
) {
  const active = new Map<string, AbortController>();
  const seen = new Set<string>();
  let closed = false;
  const message = (value: unknown) => {
    if (closed || !bounded(value)) return;
    const cancel = cancellation.safeParse(value);
    if (cancel.success && matches(cancel.data, command)) {
      active.get(cancel.data.challengeId)?.abort();
      return;
    }
    const parsed = challenge.safeParse(value);
    if (!parsed.success || !matches(parsed.data, command)) return;
    const frame = parsed.data;
    if (frame.digest !== digest(frame.request) || seen.has(frame.challengeId) || seen.size >= 8)
      return;
    seen.add(frame.challengeId);
    const abort = new AbortController();
    active.set(frame.challengeId, abort);
    const request = frame.request;
    const identity = binding.parse(
      Object.fromEntries(
        Object.entries(frame).filter(([key]) => key !== 'kind' && key !== 'request'),
      ),
    );
    void Promise.resolve()
      .then(() => approve(request, abort.signal))
      .then(
        (allowed) => {
          if (!closed && !abort.signal.aborted && command.authorization.expiresAt > Date.now())
            channel.send(
              { ...identity, kind: 'publication-decision', allowed: allowed === true },
              () => {},
            );
        },
        () => {
          if (!closed && !abort.signal.aborted)
            channel.send({ ...identity, kind: 'publication-decision', allowed: false }, () => {});
        },
      )
      .catch(() => {
        abort.abort();
      })
      .finally(() => active.delete(frame.challengeId));
  };
  channel.on('message', message);
  return () => {
    closed = true;
    channel.off('message', message);
    for (const abort of active.values()) abort.abort();
    active.clear();
  };
}
