import { createContext, useContext } from 'react';
import type { TelosSourcePacket } from '@mitzo/protocol';
export type SourceRequest = { itemId: string; snapshotId: string; conversationId: string };
export type SourceNavigation = SourceRequest & {
  status: 'loading' | 'ready' | 'unavailable';
  packet?: TelosSourcePacket;
};
export const SourceContext = createContext<SourceNavigation | null>(null);

export const useTelosSourceNavigation = () => useContext(SourceContext);
