import { createContext, useContext, type ReactNode } from 'react';

export interface ComposerStatusAction {
  label: string;
  onClick(): void;
  disabled?: boolean;
}
export type ComposerNotice = {
  message: string;
  tone?: 'normal' | 'warning' | 'danger';
  busy?: boolean;
  queued?: number;
  action?: ComposerStatusAction;
  children?: ReactNode;
};
export type ComposerStatusSink = {
  report(id: string, notice: ComposerNotice | null): void;
  mountRail(): () => void;
  close(): void;
};
export const SinkContext = createContext<ComposerStatusSink | null>(null);
export const ActiveContext = createContext(false);
export type ComposerStatusView = {
  notices: Map<string, ComposerNotice>;
  open: boolean;
  setOpen(open: boolean): void;
};
export const ViewContext = createContext<ComposerStatusView | null>(null);

export function useComposerStatusSink() {
  return useContext(SinkContext);
}
export function useComposerStatusActive() {
  return useContext(ActiveContext);
}
