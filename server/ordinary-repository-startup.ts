import { createHash } from 'node:crypto';

/** Stable server-owned identity, shared by guarded and legacy repository startup. */
export function nativeStartupSessionId(clientMsgId: string): string {
  const hex = createHash('sha256').update(`mitzo-native-startup\0${clientMsgId}`).digest('hex');
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const startups = new Set<string>();
/** Held before the first asynchronous repository/account operation. */
export function reserveRepositoryStartup(sessionId: string): () => void {
  if (startups.has(sessionId))
    throw Error('Repository conversation startup is already in progress');
  startups.add(sessionId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    startups.delete(sessionId);
  };
}
