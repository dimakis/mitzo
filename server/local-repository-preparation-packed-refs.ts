import type { NativePreparationPublicationPlan } from './native-preparation-publication.js';

/** Historical physical witness from the ORIGINAL successful allocation parser.
 * Its identity/data is retained, never a grant or a fresh namespace observation. */
export type PreparationPackedRefs = NativePreparationPublicationPlan['packedRefs'];
export function retainPreparationPackedRefs(input: unknown): PreparationPackedRefs {
  const unavailable = () => Error('Original preparation packed-ref witness unavailable');
  const data = (value: unknown, keys: readonly string[]) => {
    if (
      !value ||
      typeof value !== 'object' ||
      !Object.isFrozen(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== keys.length
    )
      throw unavailable();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || descriptor.writable || descriptor.configurable)
        throw unavailable();
      result[key] = descriptor.value;
    }
    return result;
  };
  if (!input || typeof input !== 'object') throw unavailable();
  const kind = Object.getOwnPropertyDescriptor(input, 'kind');
  if (!kind || !('value' in kind)) throw unavailable();
  if (kind.value === 'absent') {
    data(input, ['kind']);
    return input as PreparationPackedRefs;
  }
  if (kind.value !== 'file') throw unavailable();
  const item = data(input, ['kind', 'identity', 'size', 'sha256']);
  const id = data(item.identity, ['dev', 'ino']);
  if (
    ![id.dev, id.ino].every((value) => typeof value === 'string' && /^\d{1,32}$/.test(value)) ||
    typeof item.size !== 'number' ||
    !Number.isSafeInteger(item.size) ||
    item.size < 0 ||
    item.size > 16 * 1024 * 1024 ||
    typeof item.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(item.sha256)
  )
    throw unavailable();
  return input as PreparationPackedRefs;
}
