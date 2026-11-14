import { createContext, type ReactNode } from 'react';

/** A responsive screen supplies a slot, never a second draft/delivery owner. */
export const ChatInputMountContext = createContext<{
  sessionId?: string;
  attach(target: HTMLElement, content: ReactNode): () => void;
  update(target: HTMLElement, content: ReactNode): void;
  hasRetained(): boolean;
  attachRetained(target: HTMLElement): (() => void) | undefined;
} | null>(null);
