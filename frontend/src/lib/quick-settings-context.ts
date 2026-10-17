import { createContext, useContext } from 'react';

export type SettingsPage =
  | 'account'
  | 'model'
  | 'thinking'
  | 'agent'
  | 'execution'
  | 'repository'
  | 'more'
  | 'defaults'
  | 'details';
export interface SettingsDestination {
  key: SettingsPage;
  title: string;
  parent?: SettingsPage;
}
export const QuickSettingsContext = createContext<{
  page: SettingsDestination | null;
  summaryRoot: HTMLDivElement | null;
  navigate(page: SettingsDestination | null): void;
} | null>(null);

export function useQuickSettings() {
  return useContext(QuickSettingsContext);
}
