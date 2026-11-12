import { createContext, useContext } from 'react';
import type { NotificationFeed, NotificationFilter } from '@mitzo/protocol';

interface NotificationContextValue {
  feed: NotificationFeed | null;
  error: string | null;
  loading: boolean;
  filter: NotificationFilter;
  offset: number;
  setFilter: (value: NotificationFilter) => void;
  setOffset: (value: number) => void;
  refresh: () => Promise<void>;
  mutate: (path: string, body?: unknown, method?: string) => Promise<void>;
}

/** Consumers do not initialize the authenticated subscription merely by importing the context. */
export const NotificationContext = createContext<NotificationContextValue | null>(null);

export function useNotifications(): NotificationContextValue | null {
  return useContext(NotificationContext);
}
