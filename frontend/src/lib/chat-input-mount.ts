import { createContext, type ReactNode } from 'react';
import type { SharedConversationComposerRouting } from './shared-conversation-composer';
import type { ComposerStatusSink, ComposerStatusView } from './composer-status-context';

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
  updateStatus(target: HTMLElement, sink: ComposerStatusSink | null, active: boolean): void;
  updateStatusView(target: HTMLElement, view: ComposerStatusView | null): void;
  hasRetained(): boolean;
  attachRetained(target: HTMLElement): (() => void) | undefined;
} | null>(null);
