import { messagesFor, metadata } from './fixtures';
import { symposiumLive } from './symposium-fixtures';

export function previewSessionState(id: string | null) {
  return {
    ...metadata,
    messages: id ? messagesFor(id) : [],
    current: null,
    currentByMessage: id === 'preview-1' || id === 'preview-3' ? symposiumLive : {},
    running: id === 'preview-1' || id === 'preview-3',
    branch: id ? metadata.branch : null,
    wtId: id ? metadata.wtId : null,
    isWorktree: !!id,
    accountBinding: id ? metadata.accountBinding : null,
  };
}
