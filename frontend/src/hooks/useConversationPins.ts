import { useMemo, useState, useSyncExternalStore } from 'react';
import type { Session } from '../types/chat';
import { recordTitle } from '../lib/record-title';
const KEY = 'mitzo-conversation-pins';
const COLLAPSED = 'mitzo-conversation-pins-collapsed';
const CHANGED = 'mitzo:conversation-pins';
function read(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function readPins() {
  return read(KEY, '[]');
}
function readCollapsed() {
  return read(COLLAPSED, 'false') === 'true';
}
function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => {
    if (event.key == null || event.key === KEY || event.key === COLLAPSED) listener();
  };
  window.addEventListener(CHANGED, listener);
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener(CHANGED, listener);
    window.removeEventListener('storage', storage);
  };
}
function parse(raw: string): Session[] {
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    const seen = new Set<string>();
    return data
      .filter((item): item is Session => {
        if (
          !item ||
          typeof item.id !== 'string' ||
          !/^[\w.:-]{1,200}$/.test(item.id) ||
          typeof item.summary !== 'string' ||
          !Number.isFinite(item.lastModified) ||
          seen.has(item.id)
        )
          return false;
        seen.add(item.id);
        return true;
      })
      .slice(0, 100)
      .map(({ id, summary, lastModified }) => ({
        id,
        summary: recordTitle(summary),
        lastModified,
      }));
  } catch {
    return [];
  }
}
/** Keep deleted histories from leaving broken shortcuts on this device. */
export function removeConversationPins(id?: string) {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify(id ? parse(readPins()).filter((pin) => pin.id !== id) : []),
    );
    window.dispatchEvent(new Event(CHANGED));
  } catch {
    // A deleted history cannot be restored if this device refuses storage writes.
  }
}
/** Saved off-page shortcuts retain the server-confirmed title across reloads. */
export function renameConversationPin(id: string, title: string) {
  const pins = parse(readPins());
  if (!pins.some((pin) => pin.id === id)) return;
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify(
        pins.map((pin) => (pin.id === id ? { ...pin, summary: recordTitle(title) } : pin)),
      ),
    );
    window.dispatchEvent(new Event(CHANGED));
  } catch {
    // Keep the successful server rename usable even when device storage is unavailable.
  }
}
/** Device shortcuts are independent from the workspace's Today pins. */
export function useConversationPins() {
  const raw = useSyncExternalStore(subscribe, readPins, () => '[]');
  const collapsed = useSyncExternalStore(subscribe, readCollapsed, () => false);
  const pins = useMemo(() => parse(raw), [raw]);
  const [error, setError] = useState<string | null>(null);
  function write(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
      setError(null);
      window.dispatchEvent(new Event(CHANGED));
      return true;
    } catch {
      setError('Couldn’t save your conversation pins. Try again.');
      return false;
    }
  }
  function toggle(session: Session) {
    const current = parse(readPins());
    const exists = current.some((pin) => pin.id === session.id);
    if (!exists && current.length >= 100) {
      setError('You can pin up to 100 conversations.');
      return false;
    }
    return write(
      KEY,
      JSON.stringify(
        exists
          ? current.filter((pin) => pin.id !== session.id)
          : [
              ...current,
              {
                id: session.id,
                summary: recordTitle(session.summary || 'Untitled conversation'),
                lastModified: session.lastModified,
              },
            ],
      ),
    );
  }
  return {
    pins,
    collapsed,
    error,
    toggle,
    setCollapsed: (value: boolean) => write(COLLAPSED, String(value)),
    remove: (id: string) =>
      write(KEY, JSON.stringify(parse(readPins()).filter((pin) => pin.id !== id))),
  };
}
