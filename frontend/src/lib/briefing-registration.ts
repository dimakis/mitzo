import { useMemo, useSyncExternalStore } from 'react';
import { z } from 'zod';
import { apiFetch, getApiBaseUrl, AUTH_LOST_EVENT } from './api-fetch';

const identity = z.strictObject({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((value) => {
      const date = new Date(`${value}T00:00:00Z`);
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
    }),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  sessionId: z.string().regex(/^[\w.:-]{1,200}$/),
  accountId: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
});
export type BriefingRegistrationIdentity = z.infer<typeof identity>;
const recordSchema = z.strictObject({
  binding: identity,
  token: z.string().min(1).max(100),
  status: z.enum(['pending', 'failed', 'confirmed']),
  reasoningEffort: z.string().max(100).nullable().optional(),
});
type Record = z.infer<typeof recordSchema>;
const ACK = identity.extend({ createdAt: z.iso.datetime() });
const CHANGED = 'mitzo-briefing-registration-changed';
const memories = new Map<string, Map<string, Record>>();
const writeErrors = new Map<string, Set<string>>();
let authGeneration = 0;
window.addEventListener(AUTH_LOST_EVENT, () => {
  authGeneration++;
});
const inFlight = new Map<string, Promise<void>>();
const SAVE_ERROR =
  'Conversation started, but its briefing link could not be saved. Retry saving the link.';
const STORAGE_ERROR =
  'The briefing retry could not be retained across reload. Retry saving the link.';
function key() {
  const backend = new URL(getApiBaseUrl() || window.location.origin, window.location.href);
  return `mitzo-briefing-registrations:${backend.origin}${backend.pathname.replace(/\/$/, '')}`;
}
function durableKey(scope: string, sessionId: string) {
  return `${scope}:${encodeURIComponent(sessionId)}`;
}
function memory(scope: string) {
  let entries = memories.get(scope);
  if (!entries) {
    entries = new Map();
    memories.set(scope, entries);
  }
  return entries;
}
function read() {
  const scope = key();
  const cached = memory(scope);
  const failed = writeErrors.get(scope) ?? new Set<string>();
  let error = failed.size ? STORAGE_ERROR : '';
  const entries = new Map<string, Record>();
  try {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const storedKey = localStorage.key(index);
      if (storedKey?.startsWith(`${scope}:`)) keys.push(storedKey);
      if (keys.length > 256) throw new Error('Registration storage capacity reached');
    }
    for (const id of cached.keys())
      if (!keys.includes(durableKey(scope, id)) && !failed.has(id)) cached.delete(id);
    for (const storedKey of keys) {
      const raw = localStorage.getItem(storedKey);
      if (!raw || raw.length > 8 * 1024) throw new Error('Invalid registration storage');
      const record = recordSchema.parse(JSON.parse(raw));
      if (storedKey !== durableKey(scope, record.binding.sessionId))
        throw new Error('Invalid registration scope');
      entries.set(record.binding.sessionId, record);
      cached.set(record.binding.sessionId, record);
    }
  } catch {
    error = STORAGE_ERROR;
  }
  // Keep at most one additional assigned identity when capacity changes after dispatch.
  if (error)
    for (const [id, record] of cached)
      if (!entries.has(id) || failed.has(id)) entries.set(id, record);
  return { records: [...entries.values()], error, scope };
}
function notify() {
  window.dispatchEvent(new Event(CHANGED));
}
function write(record: Record) {
  const { records, scope } = read();
  const cached = memory(scope);
  const id = record.binding.sessionId;
  recordSchema.parse(record);
  const raw = JSON.stringify(record);
  if (raw.length > 8 * 1024 || (!cached.has(id) && cached.size >= 257))
    throw new Error('Briefing retry capacity reached');
  cached.set(id, record);
  const failed = writeErrors.get(scope) ?? new Set<string>();
  writeErrors.set(scope, failed);
  try {
    if (
      !localStorage.getItem(durableKey(scope, id)) &&
      records.filter((entry) => entry.binding.sessionId !== id).length >= 256
    )
      throw new Error('Briefing retry capacity reached');
    localStorage.setItem(durableKey(scope, id), raw);
    failed.delete(id);
  } catch {
    failed.add(id);
  }
  notify();
}
function remove(sessionId: string) {
  const scope = key();
  try {
    localStorage.removeItem(durableKey(scope, sessionId));
    memory(scope).delete(sessionId);
    writeErrors.get(scope)?.delete(sessionId);
  } catch {
    const failed = writeErrors.get(scope) ?? new Set<string>();
    failed.add(sessionId);
    writeErrors.set(scope, failed);
  }
  notify();
}
export function briefingRegistrationCapacityAvailable() {
  return read().records.length < 256;
}
function same(left: BriefingRegistrationIdentity, right: BriefingRegistrationIdentity) {
  return Object.keys(left).every(
    (field) => left[field as keyof typeof left] === right[field as keyof typeof right],
  );
}
function replace(record: Record) {
  const current = read().records;
  const previous = current.find((entry) => entry.binding.sessionId === record.binding.sessionId);
  if (previous && !same(previous.binding, record.binding))
    throw new Error('Reviewed briefing identity changed');
  write(record);
}
export function verifyBriefingRegistration(value: unknown) {
  const current = read().records;
  const sessionId =
    value && typeof value === 'object' && 'sessionId' in value ? value.sessionId : undefined;
  const record = current.find((entry) => entry.binding.sessionId === sessionId);
  if (!record) return;
  const binding = ACK.parse(value);
  const received = identity.parse({
    date: binding.date,
    revision: binding.revision,
    sessionId: binding.sessionId,
    accountId: binding.accountId,
    model: binding.model,
  });
  if (!same(record.binding, received))
    throw new Error('Saved briefing identity does not match the reviewed selection');
}
export function confirmBriefingRegistration(value: unknown) {
  verifyBriefingRegistration(value);
  const current = read().records;
  const sessionId =
    value && typeof value === 'object' && 'sessionId' in value ? value.sessionId : undefined;
  if (current.some((entry) => entry.binding.sessionId === sessionId)) remove(String(sessionId));
}

/** Small reviewed identity receipts persist independently of report bytes and chat mounts. */
export function registerBriefing(
  binding: BriefingRegistrationIdentity,
  reasoningEffort?: string | null,
): Promise<void> {
  const parsed = identity.parse(binding);
  const scope = key();
  const generation = authGeneration;
  const operation = `${scope}:${parsed.sessionId}`;
  const running = inFlight.get(operation);
  if (running) return running;
  const bytes = globalThis.crypto?.getRandomValues?.(new Uint8Array(16));
  const token =
    globalThis.crypto?.randomUUID?.() ??
    (bytes
      ? Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
      : `${Date.now()}:${Math.random()}`);
  const record: Record = { binding: parsed, token, status: 'pending', reasoningEffort };
  replace(record);
  const current = () =>
    authGeneration === generation &&
    key() === scope &&
    read().records.find((entry) => entry.binding.sessionId === parsed.sessionId)?.token === token;
  const promise = Promise.resolve()
    .then(async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        if (!current()) return;
        try {
          const response = await apiFetch('/api/home/briefing-chats', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(parsed),
          });
          if (response.ok) {
            const ack = ACK.parse(await response.json());
            const received = identity.parse({
              date: ack.date,
              revision: ack.revision,
              sessionId: ack.sessionId,
              accountId: ack.accountId,
              model: ack.model,
            });
            if (!same(parsed, received))
              throw new Error('Briefing registration acknowledgement changed');
            if (current()) {
              replace({ ...record, status: 'confirmed' });
              window.dispatchEvent(new CustomEvent('mitzo-briefing-chat', { detail: ack }));
            }
            return;
          }
          if (![404, 409].includes(response.status)) break;
        } catch {
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
      }
      if (current()) replace({ ...record, status: 'failed' });
    })
    .finally(() => {
      inFlight.delete(operation);
      notify();
    });
  inFlight.set(operation, promise);
  notify();
  return promise;
}
function subscribe(callback: () => void) {
  window.addEventListener(CHANGED, callback);
  window.addEventListener('storage', callback);
  return () => {
    window.removeEventListener(CHANGED, callback);
    window.removeEventListener('storage', callback);
  };
}
function snapshot() {
  const state = read();
  return JSON.stringify({ ...state, busy: [...inFlight.keys()] });
}
export function useBriefingRegistration(sessionId: string | null) {
  const raw = useSyncExternalStore(subscribe, snapshot);
  const state = useMemo(
    () => JSON.parse(raw) as ReturnType<typeof read> & { busy: string[] },
    [raw],
  );
  const record = state.records.find((entry) => entry.binding.sessionId === sessionId) ?? null;
  const saving = !!record && state.busy.includes(`${state.scope}:${sessionId}`);
  const error = record && !saving && record.status !== 'confirmed' ? state.error || SAVE_ERROR : '';
  return {
    record,
    saving,
    error,
    storageError: state.error,
    retry: () =>
      record ? registerBriefing(record.binding, record.reasoningEffort) : Promise.resolve(),
  };
}
