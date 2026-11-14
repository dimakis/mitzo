import { createContext, type ReactNode } from 'react';
import type { SharedConversationComposerRouting } from './shared-conversation-composer';

/** A responsive screen supplies a slot, never a second draft/delivery owner. */
export const ChatInputMountContext = createContext<{
  sessionId?: string;
  attach(
    target: HTMLElement,
    content: ReactNode,
    routing: SharedConversationComposerRouting,
  ): () => void;
  update(target: HTMLElement, content: ReactNode, routing: SharedConversationComposerRouting): void;
  updateRouting(target: HTMLElement, routing: SharedConversationComposerRouting): void;
  hasRetained(): boolean;
  attachRetained(target: HTMLElement): (() => void) | undefined;
} | null>(null);
