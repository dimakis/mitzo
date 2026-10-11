import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/** Exact UTF-8 SHA-256, also on supported remote HTTP without SubtleCrypto. */
export function sha256Hex(value: string): string {
  return bytesToHex(sha256(utf8ToBytes(value)));
}

/** Correlation IDs are not security credentials; retain HTTP and older-host support. */
export function createBrowserId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  // Remote HTTP keeps getRandomValues but omits secure-context randomUUID.
  // These IDs are correlation metadata, not security credentials.
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
