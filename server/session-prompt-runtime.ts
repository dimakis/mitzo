import { SessionPromptStore } from './session-prompt-store.js';
import { SessionPromptService } from './session-prompt-service.js';
import { createSessionPromptPort } from './session-prompt-dispatch.js';
import type { V2HandlerContext } from './ws-handler-v2.js';

let active: SessionPromptService | undefined;
export function initializeSessionPrompts(
  path: string,
  ctx: Pick<V2HandlerContext, 'eventStore' | 'sessionRegistry' | 'connRegistry'>,
) {
  if (active) throw Error('Session prompt runtime already initialized');
  active = new SessionPromptService(new SessionPromptStore(path), createSessionPromptPort(ctx));
  active.start();
  return active;
}
export function getSessionPrompts() {
  if (!active) throw Error('Session timers are not available on this controller.');
  return active;
}
export async function closeSessionPrompts() {
  const previous = active;
  active = undefined;
  if (previous) {
    await previous.drain();
    previous.store.close();
  }
}
