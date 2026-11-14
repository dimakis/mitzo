import { createContext, type ComponentProps } from 'react';
import type { ChatInput } from '../components/ChatInput';

/** Discussion routing is independent of source activity. The ordinary input
 * retains its draft, attachment, queue and settings owners through joining. */
export type SharedConversationComposerRouting = {
  sourceConversationId: string;
  props: Partial<ComponentProps<typeof ChatInput>>;
} | null;
export const SharedConversationComposerContext =
  createContext<SharedConversationComposerRouting>(null);
