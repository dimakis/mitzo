import { useRef } from 'react';
import { useMitzoStore } from './useStore.js';

/**
 * Returns stable references to store action functions.
 * Actions are functions on the store — they never change identity,
 * so we select them once and cache the result object.
 */
export function useActions() {
  const sendMessage = useMitzoStore((s) => s.sendMessage);
  const interruptMessage = useMitzoStore((s) => s.interruptMessage);
  const stopGeneration = useMitzoStore((s) => s.stopGeneration);
  const respondToPermission = useMitzoStore((s) => s.respondToPermission);
  const switchSession = useMitzoStore((s) => s.switchSession);
  const newSession = useMitzoStore((s) => s.newSession);
  const setMode = useMitzoStore((s) => s.setMode);
  const setModel = useMitzoStore((s) => s.setModel);
  const dispatchMessages = useMitzoStore((s) => s.dispatchMessages);
  const fetchSessionMeta = useMitzoStore((s) => s.fetchSessionMeta);

  const ref = useRef({
    sendMessage,
    interruptMessage,
    stopGeneration,
    respondToPermission,
    switchSession,
    newSession,
    setMode,
    setModel,
    dispatchMessages,
    fetchSessionMeta,
  });

  // Update refs — actions are stable but this keeps the object current
  ref.current.sendMessage = sendMessage;
  ref.current.interruptMessage = interruptMessage;
  ref.current.stopGeneration = stopGeneration;
  ref.current.respondToPermission = respondToPermission;
  ref.current.switchSession = switchSession;
  ref.current.newSession = newSession;
  ref.current.setMode = setMode;
  ref.current.setModel = setModel;
  ref.current.dispatchMessages = dispatchMessages;
  ref.current.fetchSessionMeta = fetchSessionMeta;

  return ref.current;
}
