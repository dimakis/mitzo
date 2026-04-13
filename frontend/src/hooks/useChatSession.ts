import { useState, useRef, useCallback, useEffect } from 'react';
import { LAST_SESSION_KEY } from '../lib/constants';
import { getPreferredModel, setPreferredModel } from '../lib/model-preference';

export interface ChatSessionState {
  currentSessionId: string | undefined;
  model: string;
  mode: 'ask' | 'agent' | 'auto';
}

export interface ChatSessionActions {
  setCurrentSessionId: (id: string | undefined) => void;
  setModel: (model: string) => void;
  setMode: (mode: 'ask' | 'agent' | 'auto') => void;
}

export function useChatSession(
  sessionId: string | undefined,
  initialMode: 'ask' | 'agent' | 'auto',
): [ChatSessionState, ChatSessionActions, string] {
  const [currentSessionId, setCurrentSessionId] = useState<string | undefined>(sessionId);
  const [modelState, setModelState] = useState(getPreferredModel);
  const [mode, setMode] = useState<'ask' | 'agent' | 'auto'>(initialMode);
  const setModel = useCallback((id: string) => {
    setModelState(id);
    setPreferredModel(id);
  }, []);

  // Sync currentSessionId when route param changes (critical for DesktopChatView
  // which stays mounted across session switches, unlike ChatView which remounts).
  useEffect(() => {
    setCurrentSessionId(sessionId);
  }, [sessionId]);

  const newSessionUid = useRef(`new:${Math.random().toString(36).slice(2)}`);
  const poolKey = sessionId ? `session:${sessionId}` : newSessionUid.current;

  useEffect(() => {
    if (currentSessionId) {
      localStorage.setItem(LAST_SESSION_KEY, currentSessionId);
    }
  }, [currentSessionId]);

  const state: ChatSessionState = {
    currentSessionId,
    model: modelState,
    mode,
  };

  const actions: ChatSessionActions = {
    setCurrentSessionId,
    setModel,
    setMode,
  };

  return [state, actions, poolKey];
}
