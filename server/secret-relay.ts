import { validateLanRelayEndpoint } from './secret-relay-lan.js';
import { redactCredentialResponse } from './credential-redaction.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { requestTarget, type CredentialConnectionStore } from './credential-connections.js';
import type { SecretVault, SecretVaultReference } from './openshell-secret-vault.js';
const field = z
  .string()
  .min(1)
  .max(256)
  .refine((s) => !s.split('/').some((k) => ['__proto__', 'constructor', 'prototype'].includes(k)));
const WriteSchema = z
  .object({
    path: z.string().min(1).max(4096),
    method: z.enum(['POST', 'PUT', 'PATCH']),
    encoding: z.enum(['json', 'form']),
    body: z.string().max(16384),
    fields: z.array(field).min(1).max(16),
  })
  .strict();
const TargetSchema = z.union([
  WriteSchema.extend({
    connectionId: z.string().min(1).max(128),
    revision: z.number().int().positive(),
  }).strict(),
  WriteSchema.extend({
    lanEndpoint: z
      .string()
      .max(256)
      .refine((value) => {
        try {
          validateLanRelayEndpoint(value);
          return true;
        } catch {
          return false;
        }
      }),
  }).strict(),
]);
export const PrepareSecretRelaySchema = z
  .object({
    label: z.string().trim().min(1).max(100),
    targets: z.array(TargetSchema).min(1).max(8),
  })
  .strict();
export type RelayTarget = z.infer<typeof TargetSchema>;
export type RelayOutcome = { outcome: 'not_sent' | 'unconfirmed' | 'confirmed'; status?: number };
export interface SecretRelay {
  id: string;
  sessionId: string;
  revision: number;
  label: string;
  expiresAt: number;
  status: 'pending' | 'verifying' | 'ready' | 'cancelled' | 'expired' | 'unconfirmed';
  targets: Array<RelayTarget & { endpoint: string; label: string }>;
  outcomes: RelayOutcome[];
  setupUrl: string;
  delivery?: 'pending' | 'delivered';
}
export interface StoredSecretRelay extends SecretRelay {
  vaultRef?: SecretVaultReference;
}
type Destination = {
  revision: number;
  endpoint: string;
  label: string;
  paths: string[];
  methods: string[];
  status: string;
};
type Apply = (
  session: string,
  target: RelayTarget,
  body: string,
  encoding: 'json' | 'form',
  signal: AbortSignal,
  check: () => void,
  dispatched: () => void,
  assertRuntimeCurrent?: () => Promise<void>,
) => Promise<{ status: number }>;
/** Placeholders must already exist and be empty; never traverse prototypes or
 * create fields the user did not review. RFC6901 object/array paths only. */
export function injectRelayValue(target: RelayTarget, value: string): string {
  if (new Set(target.fields).size !== target.fields.length)
    throw new Error('Duplicate secret field');
  if (target.encoding === 'form') {
    const form = new URLSearchParams(target.body);
    for (const key of target.fields) {
      if (form.getAll(key).length !== 1 || form.get(key) !== '')
        throw new Error('Expected empty secret field');
      form.set(key, value);
    }
    return form.toString();
  }
  const json: unknown = JSON.parse(target.body);
  for (const path of target.fields) {
    if (!path.startsWith('/') || /~(?![01])/.test(path)) throw new Error('Invalid JSON pointer');
    const keys = path
      .slice(1)
      .split('/')
      .map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'));
    let parent: unknown = json;
    for (const [index, key] of keys.entries()) {
      if (
        ['__proto__', 'constructor', 'prototype'].includes(key) ||
        !parent ||
        typeof parent !== 'object' ||
        !Object.hasOwn(parent, key)
      )
        throw new Error('Invalid secret field');
      const record = parent as Record<string, unknown>;
      if (index === keys.length - 1) {
        if (record[key] !== null) throw new Error('Expected null secret field');
        record[key] = value;
      } else parent = record[key];
    }
  }
  return JSON.stringify(json);
}
/** One capture, exact reviewed writes, durable at-most-once dispatch receipts.
 * SQLite contains configuration/references only, never resolved secret values. */
export class SecretRelays {
  private active = new Map<string, AbortController>();
  constructor(
    private store: CredentialConnectionStore,
    private vault: SecretVault,
    private connection: (id: string) => Destination,
    private send: Apply,
    private allowLan = false,
  ) {}
  private checkedTarget(target: RelayTarget) {
    if ('lanEndpoint' in target) {
      if (!this.allowLan) throw new Error('LAN relay adapter is disabled');
      const endpoint = validateLanRelayEndpoint(target.lanEndpoint);
      requestTarget({ endpoint: 'https://relay.invalid', paths: ['/'] }, target.path);
      injectRelayValue(target, '');
      return { endpoint, label: new URL(endpoint).hostname };
    }
    const c = this.connection(target.connectionId);
    requestTarget(c, target.path);
    if (
      c.status !== 'active' ||
      c.revision !== target.revision ||
      !c.methods.includes(target.method)
    )
      throw new Error('Destination changed');
    injectRelayValue(target, '');
    return c;
  }
  prepare(sessionId: string, input: unknown): SecretRelay {
    if (!sessionId || sessionId.length > 256) throw new Error('Session unavailable');
    const parsed = PrepareSecretRelaySchema.parse(input);
    const targets = parsed.targets.map((target) => {
      const c = this.checkedTarget(target);
      return { ...target, endpoint: c.endpoint, label: c.label };
    });
    const existing = this.store
      .listRelays()
      .find(
        (r) =>
          r.sessionId === sessionId &&
          r.status === 'pending' &&
          r.expiresAt > Date.now() &&
          r.label === parsed.label &&
          isDeepStrictEqual(r.targets, targets),
      );
    if (existing) return this.browserStatus(existing.id);
    const id = randomUUID();
    const relay: StoredSecretRelay = {
      id,
      sessionId,
      revision: 1,
      label: parsed.label,
      targets,
      outcomes: targets.map(() => ({ outcome: 'not_sent' })),
      status: 'pending',
      expiresAt: Date.now() + 30 * 60_000,
      setupUrl: `/connections/secrets/${id}`,
    };
    this.store.putRelay(relay);
    return this.browserStatus(id);
  }
  private get(id: string) {
    const relay = this.store.getRelay(id);
    if (!relay) throw new Error('Secret request unavailable');
    if (relay.expiresAt <= Date.now() && !['cancelled', 'expired'].includes(relay.status)) {
      relay.status = 'expired';
      relay.revision++;
      this.store.putRelay(relay);
    }
    return relay;
  }
  browserStatus(id: string): SecretRelay {
    const safe = { ...this.get(id) };
    delete safe.vaultRef;
    return safe;
  }
  status(session: string, id: string) {
    const relay = this.browserStatus(id);
    if (relay.sessionId !== session) throw new Error('Secret request unavailable');
    return relay;
  }
  async complete(
    id: string,
    revision: number,
    value: string,
    signal: AbortSignal,
    allowed: () => boolean,
  ) {
    const relay = this.get(id);
    if (
      relay.revision !== revision ||
      relay.status !== 'pending' ||
      this.active.has(id) ||
      !allowed()
    )
      throw new Error('Secret request changed');
    if (!value || Buffer.byteLength(value) > 16384) throw new Error('Invalid secret');
    relay.targets.forEach((t) => this.checkedTarget(t));
    const controller = new AbortController();
    this.active.set(id, controller);
    const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(30000)]);
    relay.status = 'verifying';
    relay.revision++;
    this.store.putRelay(relay);
    try {
      const vaultRef = await this.vault.save(id, value, combined);
      const current = this.get(id);
      current.vaultRef = vaultRef;
      this.store.putRelay(current);
      combined.throwIfAborted();
      if (!allowed() || current.status !== 'verifying') throw new Error();
      relay.targets.forEach((t) => this.checkedTarget(t));
      this.store.putRelay({
        ...current,
        status: 'ready',
        vaultRef,
        revision: current.revision + 1,
        delivery: 'pending',
      });
      return this.browserStatus(id);
    } catch {
      const current = this.get(id);
      if (current.status === 'verifying')
        this.store.putRelay({ ...current, status: 'unconfirmed', revision: current.revision + 1 });
      throw new Error('Secret save unconfirmed. Do not submit again; review Gateway storage.');
    } finally {
      this.active.delete(id);
    }
  }
  cancel(id: string, revision: number) {
    const relay = this.get(id);
    if (relay.revision !== revision) throw new Error('Secret request changed');
    this.active.get(id)?.abort();
    for (const [key, controller] of this.active) if (key.startsWith(`${id}:`)) controller.abort();
    this.store.putRelay({ ...relay, status: 'cancelled', revision: relay.revision + 1 });
    return this.browserStatus(id);
  }
  async redactResponse(_session: string, connectionId: string, body: string, signal: AbortSignal) {
    const endpoint = this.connection(connectionId).endpoint;
    const relays = this.store
      .listRelays()
      .filter(
        (r) =>
          r.targets.some(
            (t) =>
              ('connectionId' in t && t.connectionId === connectionId) || t.endpoint === endpoint,
          ) &&
          (r.vaultRef || ['verifying', 'unconfirmed'].includes(r.status)),
      );
    try {
      for (const relay of relays) {
        if (!relay.vaultRef) throw new Error();
        body = redactCredentialResponse(body, await this.vault.read(relay.vaultRef, signal), {});
      }
      signal.throwIfAborted();
      return body;
    } catch {
      throw new Error('Response withheld because private relay redaction is unavailable');
    }
  }
  pendingReady() {
    return this.store
      .listRelays()
      .filter((r) => r.status === 'ready' && r.delivery === 'pending' && r.expiresAt > Date.now())
      .map((r) => this.browserStatus(r.id));
  }
  markDelivered(id: string) {
    const r = this.get(id);
    if (r.status === 'ready') this.store.putRelay({ ...r, delivery: 'delivered' });
  }
  async apply(
    session: string,
    id: string,
    targetIndex: number,
    signal: AbortSignal,
    allowed: () => boolean,
    assertRuntimeCurrent?: () => Promise<void>,
  ) {
    const relay = this.get(id);
    const target = relay.targets[targetIndex];
    const check = () => {
      signal.throwIfAborted();
      const current = this.get(id);
      if (
        current.sessionId !== session ||
        current.status !== 'ready' ||
        !current.vaultRef ||
        !allowed()
      )
        throw new Error('Secret relay unavailable');
      this.checkedTarget(target);
    };
    if (!Number.isInteger(targetIndex) || targetIndex < 0 || !target)
      throw new Error('Unknown target');
    check();
    const previous = relay.outcomes[targetIndex];
    if (previous.outcome !== 'not_sent') return previous;
    const key = `${id}:${targetIndex}`;
    if (this.active.has(key)) throw new Error('Secret write in progress');
    const controller = new AbortController();
    this.active.set(key, controller);
    const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(30000)]);
    const receipt = (outcome: RelayOutcome) => {
      const current = this.get(id);
      current.outcomes[targetIndex] = outcome;
      this.store.putRelay(current);
      return outcome;
    };
    let dispatched = false;
    try {
      await assertRuntimeCurrent?.();
      check();
      const secret = await this.vault.read(relay.vaultRef!, combined);
      combined.throwIfAborted();
      check();
      const body = injectRelayValue(target, secret);
      const result = await this.send(
        session,
        target,
        body,
        target.encoding,
        combined,
        check,
        () => {
          combined.throwIfAborted();
          check();
          receipt({ outcome: 'unconfirmed' });
          dispatched = true;
        },
        assertRuntimeCurrent,
      );
      combined.throwIfAborted();
      check();
      return receipt({ outcome: 'confirmed', status: result.status });
    } catch {
      if (dispatched) return receipt({ outcome: 'unconfirmed' });
      throw new Error('Secret write was not sent');
    } finally {
      this.active.delete(key);
    }
  }
}
