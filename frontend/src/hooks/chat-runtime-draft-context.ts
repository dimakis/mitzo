import { createContext } from 'react';
import type { ChatRuntimeSelection } from '../lib/chat-runtime-selection';
export const ChatRuntimeDraftContext = createContext<{
  selection: ChatRuntimeSelection | null;
  update(selection: ChatRuntimeSelection): void;
} | null>(null);
