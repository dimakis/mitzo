import { createContext } from 'react';

export const NativeSubagentDialogContext = createContext<{
  selectedId?: string;
  origin?: 'transcript' | 'launcher';
  open(threadId?: string, origin?: 'transcript' | 'launcher'): void;
} | null>(null);
