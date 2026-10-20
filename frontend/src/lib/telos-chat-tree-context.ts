import { createContext } from 'react';
/** Display-only access to the existing frame's work-tree disclosure. */
export const TelosChatTreeContext = createContext<(() => void) | null>(null);
