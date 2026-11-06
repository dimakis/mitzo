import { createContext, type ReactNode } from 'react';

// Keep the trigger inside each existing bubble footer without threading it
// through the transcript's intermediate block renderers.
export const MessageActionsContext = createContext<ReactNode>(null);
