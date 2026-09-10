import { messagesFor, metadata } from './fixtures';

export function previewSessionState(id: string | null) {
  return {
    ...metadata,
    messages: id ? messagesFor(id) : [],
    current: null,
    running: false,
    branch: id ? metadata.branch : null,
    wtId: id ? metadata.wtId : null,
    isWorktree: !!id,
    accountBinding: id ? metadata.accountBinding : null,
  };
}
