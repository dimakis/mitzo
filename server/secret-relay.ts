import { BrowserRelayTargetSchema, type PrivateRelayBrowsers } from './secret-relay-browser.js';
import { MqttRelayTargetSchema, validateMqttRelayTarget } from './secret-relay-mqtt.js';
import { validateLanRelayEndpoint } from './secret-relay-lan.js';
import { protectSecretRelayResponse } from './secret-relay-response-protection.js';
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
const HttpTargetSchema = z.union([
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
export type HttpRelayTarget = z.infer<typeof HttpTargetSchema>;
const TargetSchema = z.union([HttpTargetSchema, MqttRelayTargetSchema, BrowserRelayTargetSchema]);
export const PrepareSecretRelaySchema = z
  .object({
    label: z.string().trim().min(1).max(100),
    targets: z.array(TargetSchema).min(1).max(8),
  })
  .strict();
export type RelayTarget = z.infer<typeof TargetSchema>;
export type RelayOutcome = {
  outcome: 'not_sent' | 'unconfirmed' | 'confirmed' | 'challenge_required';
  challenge?: 'awaiting_code' | 'code_ready';
  status?: number;
  acknowledgement?: 'connack' | 'puback';
};
export interface SecretRelay {
  id: string;
  sessionId: string;
  revision: number;
  label: string;
  expiresAt: number;
  status: 'pending' | 'verifying' | 'ready' | 'cancelled' | 'expired' | 'unconfirmed';
  targets: Array<RelayTarget & { endpoint: string; label: string }>;
  outcomes: RelayOutcome[];
  actionOutcomes?: Record<string, RelayOutcome>;
  continuation?: number;
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
) => Promise<{ status?: number; acknowledgement?: 'connack' | 'puback' }>;
/** Placeholders must already exist and be empty; never traverse prototypes or
 * create fields the user did not review. RFC6901 object/array paths only. */
export function injectRelayValue(target: HttpRelayTarget, value: string): string {
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
    private adapters: { mqtt?: boolean; mqttLan?: boolean; browser?: PrivateRelayBrowsers } = {},
  ) {}
  private checkedTarget(target: RelayTarget) {
    if ('adapter' in target && target.adapter === 'browser') {
      if (!this.adapters.browser) throw new Error('Private browser adapter disabled');
      const input = { ...target } as typeof target & { endpoint?: string; label?: string };
      delete input.endpoint;
      delete input.label;
      const t = BrowserRelayTargetSchema.parse(input);
      return { endpoint: t.origin, label: new URL(t.origin).hostname };
    }
    if ('adapter' in target) {
      if (!this.adapters.mqtt) throw new Error('MQTT relay adapter is disabled');
      const url = validateMqttRelayTarget(target, !!this.adapters.mqttLan);
      return { endpoint: target.broker, label: url.hostname };
    }
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
      void this.adapters.browser?.closeRelay(id).catch(() => {});
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
    const combined = AbortSignal.any([
      signal,
      controller.signal,
      AbortSignal.timeout(Math.max(1, Math.min(30000, relay.expiresAt - Date.now()))),
    ]);
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
    void this.adapters.browser?.closeRelay(id).catch(() => {});
    this.active.get(id)?.abort();
    for (const [key, controller] of this.active) if (key.startsWith(`${id}:`)) controller.abort();
    this.store.putRelay({ ...relay, status: 'cancelled', revision: relay.revision + 1 });
    return this.browserStatus(id);
  }
  provideBrowserCode(
    id: string,
    revision: number,
    targetIndex: number,
    value: string,
    allowed: () => boolean,
  ) {
    const relay = this.get(id);
    const target = relay.targets[targetIndex];
    if (
      relay.status !== 'ready' ||
      relay.revision !== revision ||
      !allowed() ||
      !target ||
      !('adapter' in target) ||
      target.adapter !== 'browser' ||
      relay.outcomes[targetIndex]?.challenge !== 'awaiting_code'
    )
      throw new Error('Private verification request changed');
    this.checkedTarget(target);
    this.adapters.browser!.provideCode(`${id}:${targetIndex}`, value);
    relay.outcomes[targetIndex] = { outcome: 'challenge_required', challenge: 'code_ready' };
    relay.revision++;
    relay.delivery = 'pending';
    relay.continuation = (relay.continuation ?? 0) + 1;
    this.store.putRelay(relay);
    return this.browserStatus(id);
  }
  async dispose() {
    for (const controller of this.active.values()) controller.abort();
    await this.adapters.browser?.dispose();
  }
  async redactResponse(_session: string, connectionId: string, body: string, signal: AbortSignal) {
    return protectSecretRelayResponse(
      this.store,
      connectionId,
      this.connection(connectionId).endpoint,
      body,
      signal,
      (ref, abort) => this.vault.read(ref, abort),
    );
  }

  pendingReady() {
    return this.store
      .listRelays()
      .filter((r) => r.status === 'ready' && r.delivery === 'pending' && r.expiresAt > Date.now())
      .map((r) => this.browserStatus(r.id));
  }
  markDelivered(id: string, revision?: number) {
    const r = this.get(id);
    if (r.status === 'ready' && (revision === undefined || r.revision === revision))
      this.store.putRelay({ ...r, delivery: 'delivered' });
  }
  async apply(
    session: string,
    id: string,
    targetIndex: number,
    signal: AbortSignal,
    allowed: () => boolean,
    assertRuntimeCurrent?: () => Promise<void>,
    actionIndex?: number,
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
    const browserTarget = 'adapter' in target && target.adapter === 'browser' ? target : undefined;
    if (
      actionIndex !== undefined &&
      (!browserTarget ||
        !Number.isInteger(actionIndex) ||
        actionIndex < 0 ||
        !browserTarget.actions[actionIndex])
    )
      throw new Error('Unknown browser action');
    if (actionIndex !== undefined && relay.outcomes[targetIndex].outcome !== 'confirmed')
      throw new Error('Browser sign-in incomplete');
    const actionKey = `${targetIndex}:${actionIndex}`;
    const previous =
      actionIndex === undefined
        ? relay.outcomes[targetIndex]
        : (relay.actionOutcomes?.[actionKey] ?? { outcome: 'not_sent' as const });
    const codeReady =
      actionIndex === undefined &&
      browserTarget &&
      previous.outcome === 'challenge_required' &&
      previous.challenge === 'code_ready';
    if (previous.outcome !== 'not_sent' && !codeReady) return previous;
    const key =
      actionIndex === undefined
        ? `${id}:${targetIndex}`
        : `${id}:${targetIndex}:action:${actionIndex}`;
    if (this.active.has(key)) throw new Error('Secret write in progress');
    const controller = new AbortController();
    this.active.set(key, controller);
    const combined = AbortSignal.any([
      signal,
      controller.signal,
      AbortSignal.timeout(Math.max(1, Math.min(30000, relay.expiresAt - Date.now()))),
    ]);
    const receipt = (outcome: RelayOutcome) => {
      const current = this.get(id);
      if (actionIndex === undefined) current.outcomes[targetIndex] = outcome;
      else {
        current.actionOutcomes ??= {};
        current.actionOutcomes[actionKey] = outcome;
      }
      if (outcome.outcome === 'challenge_required') current.revision++;
      this.store.putRelay(current);
      return outcome;
    };
    let dispatched = false;
    try {
      await assertRuntimeCurrent?.();
      check();
      const dispatchedNow = () => {
        combined.throwIfAborted();
        check();
        receipt({ outcome: 'unconfirmed' });
        dispatched = true;
      };
      const gate = {
        signal: combined,
        check,
        dispatched: dispatchedNow,
        assertCurrent: assertRuntimeCurrent,
      };
      if (browserTarget && (codeReady || actionIndex !== undefined)) {
        const result = codeReady
          ? await this.adapters.browser!.completeProvidedCode(`${id}:${targetIndex}`, gate)
          : await this.adapters.browser!.action(`${id}:${targetIndex}`, actionIndex!, gate);
        combined.throwIfAborted();
        check();
        return receipt(result);
      }
      const secret = await this.vault.read(relay.vaultRef!, combined);
      combined.throwIfAborted();
      check();
      if (browserTarget) {
        const result = await this.adapters.browser!.login(
          `${id}:${targetIndex}`,
          browserTarget,
          secret,
          relay.expiresAt,
          gate,
        );
        combined.throwIfAborted();
        check();
        return receipt(
          result.outcome === 'challenge_required'
            ? { ...result, challenge: 'awaiting_code' }
            : result,
        );
      }
      const body = 'adapter' in target ? secret : injectRelayValue(target, secret);
      const result = await this.send(
        session,
        target,
        body,
        'encoding' in target ? target.encoding : 'form',
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
      return receipt({ outcome: 'confirmed', ...result });
    } catch {
      if (dispatched || codeReady) return receipt({ outcome: 'unconfirmed' });
      throw new Error('Secret write was not sent');
    } finally {
      this.active.delete(key);
    }
  }
}
