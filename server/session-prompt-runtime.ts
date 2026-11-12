import { SessionPromptStore } from './session-prompt-store.js';
import { SessionPromptService } from './session-prompt-service.js';
import {
  createSessionPromptPort,
  type OrdinarySessionPromptPort,
} from './session-prompt-dispatch.js';
import type { V2HandlerContext } from './ws-handler-v2.js';

let active: SessionPromptService | undefined;
let ordinaryPort: OrdinarySessionPromptPort | undefined;
export function initializeSessionPrompts(
  path: string,
  ctx: Pick<V2HandlerContext, 'eventStore' | 'sessionRegistry' | 'connRegistry'>,
) {
  if (active) throw Error('Session prompt runtime already initialized');
  ordinaryPort = createSessionPromptPort(ctx);
  active = new SessionPromptService(new SessionPromptStore(path), ordinaryPort);
  active.start();
  return active;
}
export function getSessionPrompts() {
  if (!active) throw Error('Session timers are not available on this controller.');
  return active;
}
/** Existing guarded admission owner; not a new public dispatch or credential route. */
export function getOrdinarySessionPromptPort() {
  if (!ordinaryPort) throw Error('Ordinary prompt admission is not available on this controller.');
  return ordinaryPort;
}
export async function closeSessionPrompts() {
  const previous = active;
  active = undefined;
  ordinaryPort = undefined;
  if (previous) {
    await previous.drain();
    previous.store.close();
  }
}
