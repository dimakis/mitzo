import { SessionLaunchDefaultsStore } from './session-launch-defaults.js';
import { SessionLaunchStore } from './session-launch-store.js';
import { SessionLaunchService } from './session-launch-service.js';
import { createSessionLaunchPort } from './session-launch-runtime.js';

export interface SessionLaunchController {
  defaults: SessionLaunchDefaultsStore;
  launches: SessionLaunchService;
  changed(sessionId: string): void;
}
let active: SessionLaunchController | undefined;
export function initializeSessionLaunches(path: string, changed: (sessionId: string) => void) {
  if (active) throw Error('Session launch controller already initialized');
  const defaults = new SessionLaunchDefaultsStore(path);
  const store = new SessionLaunchStore(path);
  active = {
    defaults,
    launches: new SessionLaunchService(store, createSessionLaunchPort()),
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
