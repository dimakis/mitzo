import { useMitzoStore } from './useStore.js';

export function useActions() {
  return useMitzoStore((s) => ({
    sendMessage: s.sendMessage,
    interruptMessage: s.interruptMessage,
    stopGeneration: s.stopGeneration,
    respondToPermission: s.respondToPermission,
    switchSession: s.switchSession,
    newSession: s.newSession,
    setMode: s.setMode,
    setModel: s.setModel,
    dispatchMessages: s.dispatchMessages,
    fetchSessionMeta: s.fetchSessionMeta,
  }));
}
