import { initializeChatStorage } from './lib/large-chat-storage';

// Missing payloads retain the existing fail-closed draft/outbox recovery behavior.
void initializeChatStorage()
  .catch(() => {})
  .then(() => import('./render-app'));
