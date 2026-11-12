import { SessionLaunchDefaultsStore } from './session-launch-defaults.js';
import { SessionLaunchStore } from './session-launch-store.js';
import { SessionLaunchService } from './session-launch-service.js';
import { createSessionLaunchPort } from './session-launch-runtime.js';
import type { createTelosSessionLaunchHost } from './telos-session-launch-host.js';

export interface SessionLaunchController {
  defaults: SessionLaunchDefaultsStore;
  launches: SessionLaunchService;
  changed(sessionId: string): void;
  telos?: ReturnType<typeof createTelosSessionLaunchHost>;
}
let active: SessionLaunchController | undefined;
export function initializeSessionLaunches(
  path: string,
  changed: (sessionId: string) => void,
  createTelos?: (store: SessionLaunchStore) => ReturnType<typeof createTelosSessionLaunchHost>,
) {
  if (active) throw Error('Session launch controller already initialized');
  const defaults = new SessionLaunchDefaultsStore(path);
  const store = new SessionLaunchStore(path);
  const telos = createTelos?.(store);
  active = {
    defaults,
    launches: new SessionLaunchService(store, createSessionLaunchPort(), telos),
    ...(telos ? { telos } : {}),
    changed,
  };
  return active;
}
export function getSessionLaunches(): SessionLaunchController {
  if (!active) throw Error('Session creation is unavailable on this controller.');
  return active;
}
export function closeSessionLaunches() {
  const previous = active;
  active = undefined;
  previous?.defaults.close();
  previous?.launches.store.close();
}
