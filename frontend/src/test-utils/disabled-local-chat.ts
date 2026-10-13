import { createChatRuntimeSelection } from '../lib/chat-runtime-selection';
/** Legacy page unit fixtures explicitly leave the new route gate off. */
export function disabledLocalChat() {
  return {
    intent: createChatRuntimeSelection(),
    inventory: null,
    visible: false,
    selectedLocal: false,
    bound: false,
    metadataPending: false,
    binding: null,
    reason: undefined,
    error: '',
    refresh() {},
    update() {},
    review() {},
  };
}
