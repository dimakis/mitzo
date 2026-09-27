import {
  mkdirSync,
  realpathSync,
  statSync,
  openSync,
  closeSync,
  fstatSync,
  constants,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { CapabilityOperationStore } from './connections/capabilities/operation-store.js';
interface Owner {
  store: CapabilityOperationStore;
  pending: Set<Promise<unknown>>;
  draining: boolean;
}
const owners = new Map<string, Owner>();
const byStore = new WeakMap<CapabilityOperationStore, Owner>();
/** One bootstrap owner for the existing canonical capabilities.db, independent
 * of whether the legacy gateway adapters or sealed publication initialize first. */
export function capabilityOperationStore(directory: string): CapabilityOperationStore {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const canonical = realpathSync(resolve(directory));
  const stat = statSync(canonical);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o022)
    throw new Error('Capability operation directory custody unavailable');
  const previous = owners.get(canonical);
  if (previous) {
    if (previous.draining) throw new Error('Capability operations are draining');
    return previous.store;
  }
  const path = join(canonical, 'capabilities.db');
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || file.uid !== process.getuid?.() || file.mode & 0o022)
      throw new Error('Capability operation file custody unavailable');
  } finally {
    closeSync(fd);
  }
  const store = new CapabilityOperationStore(path);
  const owner: Owner = { store, pending: new Set(), draining: false };
  owners.set(canonical, owner);
  byStore.set(store, owner);
  return store;
}
export async function trackCapabilityOperation<T>(
  store: CapabilityOperationStore,
  action: () => Promise<T>,
): Promise<T> {
  const owner = byStore.get(store);
  if (!owner) return action(); // Explicit isolated test stores retain their own lifecycle.
  if (owner.draining) throw new Error('Capability operations are draining');
  const pending = Promise.resolve().then(action);
  owner.pending.add(pending);
  try {
    return await pending;
  } finally {
    owner.pending.delete(pending);
  }
}
/** Only global bootstrap shutdown closes the shared database, after all tracked
 * invokes/recovery have settled. A failed drain leaves the owner open and fenced. */
export async function closeCapabilityOperationStores(signal: AbortSignal) {
  const snapshot = [...owners.entries()];
  for (const [, owner] of snapshot) owner.draining = true;
  signal.throwIfAborted();
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('Capability operation drain interrupted'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    await Promise.race([
      Promise.allSettled(snapshot.flatMap(([, owner]) => [...owner.pending])),
      aborted,
    ]);
    signal.throwIfAborted();
    for (const [directory, owner] of snapshot) {
      owner.store.close();
      owners.delete(directory);
    }
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
