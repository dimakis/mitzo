import type { MitzoMode } from '@mitzo/protocol';

// Revisions only coordinate in-flight startups in this server process. A
// timestamp cannot distinguish multiple acknowledged changes in one millisecond.
const revisions = new WeakMap<object, Map<string, symbol>>();

export interface ResumePermission {
  mode: MitzoMode;
  revision: symbol | undefined;
}

export function permissionRevision(store: object, sessionId: string): symbol | undefined {
  return revisions.get(store)?.get(sessionId);
}

export function recordPermissionChange(store: object, sessionId: string): void {
  let sessions = revisions.get(store);
  if (!sessions) {
    sessions = new Map();
    revisions.set(store, sessions);
  }
  sessions.set(sessionId, Symbol('permission-change'));
}
