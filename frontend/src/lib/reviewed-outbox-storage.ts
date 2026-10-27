import { CHAT_MAX_COMMAND_BYTES } from '@mitzo/protocol';
import { V2SendMessage } from '@mitzo/protocol';
import { parseLocalCommandDelivery } from '@mitzo/client';
import { acceptedComposerDraftKey, composerDraftProof } from './composer-draft-proof';

type Disk = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'> & {
  flush?: () => Promise<void>;
};
type Entry = {
  body: Record<string, unknown>;
  scope: number;
  uncertain?: boolean;
  ordinaryDelivery?: unknown;
  composerDraft?: unknown;
  localReceipt?: { state?: unknown };
};
const MAX_ENTRY_BYTES = CHAT_MAX_COMMAND_BYTES + 64 * 1024;
const MAX_TOTAL_BYTES = 2 * MAX_ENTRY_BYTES;
/** Per-command launch persistence survives tab and native WebView recreation.
 * Independent tabs can acknowledge their own commands without overwriting another draft.
 */
export function createReviewedOutboxStorage(
  disk: Disk,
  backendSendUrl: string,
  route: 'launch' | 'local' = 'launch',
): Pick<Storage, 'getItem' | 'setItem'> & { flush?: () => Promise<void> } {
  const prefix = `mitzo-${route === 'local' ? 'local-first-command' : 'reviewed-send'}-outbox:${encodeURIComponent(backendSendUrl)}:`;
  let owned = new Set<string>();
  const key = (id: string) => prefix + encodeURIComponent(id);
  function decode(raw: string): Entry {
    if (new TextEncoder().encode(raw).length > MAX_ENTRY_BYTES)
      throw new Error('Reviewed command exceeds storage bound');
    const value = JSON.parse(raw) as Entry;
    if (
      !value ||
      !Number.isSafeInteger(value.scope) ||
      value.scope < 0 ||
      (value.uncertain !== undefined && typeof value.uncertain !== 'boolean')
    )
      throw new Error('Invalid reviewed command envelope');
    if (route === 'local') {
      parseLocalCommandDelivery(value.body, value.ordinaryDelivery);
      return value;
    }
    const parsed = V2SendMessage.safeParse(value.body);
    if (!parsed.success || parsed.data.sessionId !== null)
      throw new Error('Invalid reviewed command');
    return value;
  }
  function all(): Map<string, string> {
    const result = new Map<string, string>();
    let bytes = 0;
    for (let i = 0; i < disk.length; i++) {
      const storedKey = disk.key(i);
      if (!storedKey?.startsWith(prefix)) continue;
      const raw = disk.getItem(storedKey);
      if (!raw) throw new Error('Missing reviewed command');
      const entry = decode(raw);
      const id = String(entry.body.clientMsgId);
      if (storedKey !== key(id) || result.has(id))
        throw new Error('Reviewed command identity mismatch');
      result.set(id, raw);
      bytes += new TextEncoder().encode(raw).length;
      if (result.size > 100 || bytes > MAX_TOTAL_BYTES)
        throw new Error('Reviewed command storage capacity reached');
    }
    return result;
  }
  return {
    ...(disk.flush ? { flush: () => disk.flush!() } : {}),
    getItem() {
      const entries = all();
      owned = new Set(entries.keys());
      return JSON.stringify([...entries.values()].map(decode));
    },
    setItem(_name, raw) {
      const values: unknown = JSON.parse(raw);
      if (!Array.isArray(values) || values.length > 100)
        throw new Error('Reviewed command queue capacity reached');
      const next = new Map<string, string>();
      for (const value of values) {
        const serialized = JSON.stringify(value);
        const entry = decode(serialized);
        const id = String(entry.body.clientMsgId);
        if (next.has(id)) throw new Error('Duplicate reviewed command');
        next.set(id, serialized);
      }
      const existing = all();
      const merged = new Map(existing);
      for (const id of owned) if (!next.has(id)) merged.delete(id);
      for (const [id, value] of next) merged.set(id, value);
      if (
        merged.size > 100 ||
        [...merged.values()].reduce(
          (sum, value) => sum + new TextEncoder().encode(value).length,
          0,
        ) > MAX_TOTAL_BYTES
      )
        throw new Error('Reviewed command storage capacity reached');
      const added = [...next].filter(([id]) => !existing.has(id));
      // SendOutbox enqueues one command at a time. Write that new key last, so
      // quota failure cannot leave a silently accepted partial new launch.
      if (added.length > 1) throw new Error('Reviewed commands must be retained individually');
      for (const [id, value] of next)
        if (existing.has(id) && existing.get(id) !== value) disk.setItem(key(id), value);
      for (const id of owned) {
        if (next.has(id)) continue;
        const raw = existing.get(id);
        const retired = raw ? decode(raw) : undefined;
        const proof = composerDraftProof(retired?.composerDraft);
        if (
          route === 'local' &&
          proof &&
          retired?.localReceipt?.state === 'consumed' &&
          retired.uncertain === false
        )
          // Commit local completion before dropping its last durable receipt.
          // A WebView can disappear before the composer's React effect runs.
          disk.setItem(acceptedComposerDraftKey(proof.storageKey), JSON.stringify(proof));
        disk.removeItem(key(id));
      }
      for (const [id, value] of added) disk.setItem(key(id), value);
      owned = new Set(next.keys());
    },
  };
}
