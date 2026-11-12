import { useSyncExternalStore } from 'react';
import { z } from 'zod';

const key = 'mitzo-model-picker-hidden';
const schema = z.record(z.string(), z.array(z.string()));
const listeners = new Set<() => void>();
let fallback = '{}';
let warned = false;
let memoryOnly = false;
function diagnostic(cause: unknown) {
  if (warned) return;
  warned = true;
  console.warn('[mitzo] Model picker preferences unavailable', {
    stage: 'model_picker_preferences',
    code: 'model_visibility_storage_unavailable',
    errorType: cause instanceof Error ? cause.name : 'unknown',
  });
}
function raw(): string {
  if (memoryOnly) return fallback;
  try {
    return localStorage.getItem(key) ?? '{}';
  } catch (cause) {
    memoryOnly = true;
    diagnostic(cause);
    return fallback;
  }
}
function snapshot(): string {
  const value = raw();
  return `${memoryOnly ? 'tab' : 'stored'}:${value}`;
}
function read(): Record<string, string[]> {
  try {
    return schema.parse(JSON.parse(raw()));
  } catch (cause) {
    diagnostic(cause);
    return {};
  }
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const storage = (event: StorageEvent) => {
    if (!event.key || event.key === key) listener();
  };
  window.addEventListener('storage', storage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', storage);
  };
}
export function useModelVisibility() {
  useSyncExternalStore(subscribe, snapshot, () => 'stored:{}');
  return { persistent: !memoryOnly };
}
export function hiddenPickerModels(accountId: string): string[] {
  const accounts = read();
  return Object.hasOwn(accounts, accountId) ? accounts[accountId] : [];
}
export function setHiddenPickerModels(accountId: string, ids: string[]) {
  const next = { ...read(), [accountId]: [...new Set(ids)] };
  fallback = JSON.stringify(next);
  try {
    localStorage.setItem(key, fallback);
  } catch (cause) {
    memoryOnly = true;
    diagnostic(cause);
  }
  for (const listener of listeners) listener();
}
/** Presentation only: never changes the server catalog, binding or authority. */
export function pickerModels<T extends { id: string }>(
  accountId: string,
  models: T[],
  current?: string,
): T[] {
  const hidden = new Set(hiddenPickerModels(accountId));
  return models.filter((model) => model.id === current || !hidden.has(model.id));
}
