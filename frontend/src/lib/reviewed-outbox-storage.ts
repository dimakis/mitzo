import { CHAT_MAX_COMMAND_BYTES, RuntimeFailureSchema, type RuntimeFailure } from '@mitzo/protocol';
import { V2SendMessage } from '@mitzo/protocol';
import {
  parseLocalCommandDelivery,
  CommandDeliveryDiagnosticSchema,
  type CommandDeliveryDiagnostic,
} from '@mitzo/client';
import {
  acceptedComposerDraftKey,
  composerDraftProof,
  composerDraftRevisionKey,
  type ComposerDraftProof,
  COMPOSER_DRAFT_ACCEPTED,
} from './composer-draft-proof';

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
  runtimeFailure?: unknown;
  deliveryDiagnostic?: unknown;
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
  // Display-only diagnostics must not extend the strict command envelope read
  // by an older open tab or a rolled-back client. Their separate namespace
  // cannot be mistaken for a queued command by those consumers.
  const diagnosticKey = (id: string) =>
    `mitzo-command-diagnostic:${encodeURIComponent(backendSendUrl)}:${encodeURIComponent(id)}`;
  const deliveryDiagnosticKey = (id: string) =>
    `mitzo-command-delivery-diagnostic:${encodeURIComponent(backendSendUrl)}:${encodeURIComponent(id)}`;
  function deliveryDiagnostic(id: string): CommandDeliveryDiagnostic | undefined {
    if (route !== 'local') return undefined;
    try {
      const raw = disk.getItem(deliveryDiagnosticKey(id));
      return raw && raw.length <= 512
        ? CommandDeliveryDiagnosticSchema.safeParse(JSON.parse(raw)).data
        : undefined;
    } catch {
      // An optional malformed display hint cannot block the original command.
      return undefined;
    }
  }
  function diagnostic(id: string): RuntimeFailure | undefined {
    if (route !== 'local') return undefined;
    try {
      const raw = disk.getItem(diagnosticKey(id));
      return raw && raw.length <= 512
        ? RuntimeFailureSchema.safeParse(JSON.parse(raw)).data
        : undefined;
    } catch {
      return undefined;
    }
  }
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
  function hasDifferentComposerRevision(proof: ComposerDraftProof): boolean {
    try {
      const current = JSON.parse(
        disk.getItem(composerDraftRevisionKey(proof.storageKey)) ?? 'null',
      );
      return (
        typeof current?.revisionToken === 'string' &&
        /^\S{1,200}$/.test(current.revisionToken) &&
        typeof current.textSha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(current.textSha256) &&
        (current.richDraftSignature === undefined ||
          current.richDraftSignature === '' ||
          (typeof current.richDraftSignature === 'string' &&
            /^[a-f0-9]{64}$/.test(current.richDraftSignature))) &&
        current.revisionToken !== proof.revisionToken
      );
    } catch {
      return false;
    }
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
      return JSON.stringify(
        [...entries].map(([id, raw]) => {
          const entry = decode(raw);
          const hint = diagnostic(id);
          const deliveryHint = deliveryDiagnostic(id);
          return {
            ...entry,
            ...(hint ? { runtimeFailure: hint } : {}),
            ...(deliveryHint ? { deliveryDiagnostic: deliveryHint } : {}),
          };
        }),
      );
    },
    setItem(_name, raw) {
      const values: unknown = JSON.parse(raw);
      if (!Array.isArray(values) || values.length > 100)
        throw new Error('Reviewed command queue capacity reached');
      const next = new Map<string, string>();
      const diagnostics = new Map<string, RuntimeFailure | undefined>();
      const deliveryDiagnostics = new Map<string, CommandDeliveryDiagnostic | undefined>();
      for (const value of values) {
        const serialized = JSON.stringify(value);
        const entry = decode(serialized);
        const id = String(entry.body.clientMsgId);
        if (next.has(id)) throw new Error('Duplicate reviewed command');
        if (route === 'local') {
          diagnostics.set(id, RuntimeFailureSchema.safeParse(entry.runtimeFailure).data);
          deliveryDiagnostics.set(
            id,
            CommandDeliveryDiagnosticSchema.safeParse(entry.deliveryDiagnostic).data,
          );
          const envelope = { ...entry };
          delete envelope.runtimeFailure;
          delete envelope.deliveryDiagnostic;
          next.set(id, JSON.stringify(envelope));
        } else next.set(id, serialized);
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
      // Save hints before adding a new command, preserving the existing rule
      // that a quota failure cannot leave a partially accepted new launch.
      for (const [id, failure] of diagnostics) {
        if (failure) disk.setItem(diagnosticKey(id), JSON.stringify(failure));
        else if (disk.getItem(diagnosticKey(id)) !== null) disk.removeItem(diagnosticKey(id));
      }
      for (const [id, failure] of deliveryDiagnostics) {
        if (failure) disk.setItem(deliveryDiagnosticKey(id), JSON.stringify(failure));
        else if (disk.getItem(deliveryDiagnosticKey(id)) !== null)
          disk.removeItem(deliveryDiagnosticKey(id));
      }
      let acceptedDraft = false;
      for (const id of owned) {
        if (next.has(id)) continue;
        const raw = existing.get(id);
        const retired = raw ? decode(raw) : undefined;
        const proof = composerDraftProof(retired?.composerDraft);
        if (
          route === 'local' &&
          proof &&
          retired?.localReceipt?.state === 'consumed' &&
          retired.uncertain === false &&
          !hasDifferentComposerRevision(proof)
        ) {
          // A different durable draft token already fences this submitted
          // revision. Its obsolete marker cannot clear the current editor and
          // must not prevent accepted delivery from retiring at storage quota.
          // Commit a still-owned revision before dropping its last receipt.
          // A WebView can disappear before the composer's React effect runs.
          disk.setItem(acceptedComposerDraftKey(proof.storageKey), JSON.stringify(proof));
          acceptedDraft = true;
        }
        disk.removeItem(key(id));
        if (route === 'local' && disk.getItem(diagnosticKey(id)) !== null)
          disk.removeItem(diagnosticKey(id));
        if (route === 'local' && disk.getItem(deliveryDiagnosticKey(id)) !== null)
          disk.removeItem(deliveryDiagnosticKey(id));
      }
      for (const [id, value] of added) disk.setItem(key(id), value);
      owned = new Set(next.keys());
      if (acceptedDraft && typeof window !== 'undefined')
        window.dispatchEvent(new Event(COMPOSER_DRAFT_ACCEPTED));
    },
  };
}
