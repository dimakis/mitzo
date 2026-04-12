import { useReducer, useCallback } from 'react';

export type TabType = 'chat' | 'file';

/** Discriminated union: chat tabs have no filePath, file tabs require one. */
export type Tab = ChatTab | FileTab;

export interface ChatTab {
  id: string;
  type: 'chat';
  label: string;
}

export interface FileTab {
  id: string;
  type: 'file';
  label: string;
  filePath: string;
}

const CHAT_TAB_ID = 'chat'; // singleton chat tab

interface TabState {
  tabs: Tab[];
  activeTabId: string;
}

type TabAction =
  | { type: 'OPEN_FILE'; filePath: string; label: string }
  | { type: 'CLOSE'; tabId: string }
  | { type: 'ACTIVATE'; tabId: string }
  | { type: 'ACTIVATE_CHAT' };

function tabReducer(state: TabState, action: TabAction): TabState {
  switch (action.type) {
    case 'OPEN_FILE': {
      const tabId = `file:${action.filePath}`;
      const alreadyOpen = state.tabs.some((t) => t.id === tabId);
      return {
        tabs: alreadyOpen
          ? state.tabs
          : [
              ...state.tabs,
              { id: tabId, type: 'file', label: action.label, filePath: action.filePath },
            ],
        activeTabId: tabId,
      };
    }
    case 'CLOSE': {
      if (action.tabId === CHAT_TAB_ID) return state;
      const idx = state.tabs.findIndex((t) => t.id === action.tabId);
      const next = state.tabs.filter((t) => t.id !== action.tabId);
      let { activeTabId } = state;
      if (action.tabId === activeTabId && next.length > 0) {
        const newIdx = Math.min(idx, next.length - 1);
        activeTabId = next[newIdx].id;
      }
      return { tabs: next, activeTabId };
    }
    case 'ACTIVATE':
      return { ...state, activeTabId: action.tabId };
    case 'ACTIVATE_CHAT':
      return { ...state, activeTabId: CHAT_TAB_ID };
  }
}

const initialState: TabState = {
  tabs: [{ id: CHAT_TAB_ID, type: 'chat', label: 'Chat' }],
  activeTabId: CHAT_TAB_ID,
};

export function useDesktopTabs() {
  const [state, dispatch] = useReducer(tabReducer, initialState);

  const openFileTab = useCallback((filePath: string, label: string) => {
    dispatch({ type: 'OPEN_FILE', filePath, label });
  }, []);

  const closeTab = useCallback((tabId: string) => {
    dispatch({ type: 'CLOSE', tabId });
  }, []);

  const activateTab = useCallback((tabId: string) => {
    dispatch({ type: 'ACTIVATE', tabId });
  }, []);

  const activateChatTab = useCallback(() => {
    dispatch({ type: 'ACTIVATE_CHAT' });
  }, []);

  return {
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    openFileTab,
    closeTab,
    activateTab,
    activateChatTab,
    CHAT_TAB_ID,
  };
}
