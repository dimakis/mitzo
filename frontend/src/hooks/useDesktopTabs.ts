import { useState, useCallback } from 'react';

export type TabType = 'chat' | 'file';

export interface Tab {
  id: string;
  type: TabType;
  label: string;
  /** Session ID for chat tabs */
  sessionId?: string;
  /** Absolute file path for file tabs */
  filePath?: string;
}

const CHAT_TAB_ID = 'chat'; // singleton chat tab

export function useDesktopTabs() {
  const [tabs, setTabs] = useState<Tab[]>([{ id: CHAT_TAB_ID, type: 'chat', label: 'Chat' }]);
  const [activeTabId, setActiveTabId] = useState(CHAT_TAB_ID);

  const openFileTab = useCallback((filePath: string, label: string) => {
    const tabId = `file:${filePath}`;
    setTabs((prev) => {
      if (prev.some((t) => t.id === tabId)) return prev;
      return [...prev, { id: tabId, type: 'file', label, filePath }];
    });
    setActiveTabId(tabId);
  }, []);

  const closeTab = useCallback(
    (tabId: string) => {
      // Can't close the chat tab
      if (tabId === CHAT_TAB_ID) return;
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.id === tabId);
        const next = prev.filter((t) => t.id !== tabId);
        // If closing the active tab, activate the neighbor
        if (tabId === activeTabId && next.length > 0) {
          const newIdx = Math.min(idx, next.length - 1);
          setActiveTabId(next[newIdx].id);
        }
        return next;
      });
    },
    [activeTabId],
  );

  const activateTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);
  }, []);

  const activateChatTab = useCallback(() => {
    setActiveTabId(CHAT_TAB_ID);
  }, []);

  return { tabs, activeTabId, openFileTab, closeTab, activateTab, activateChatTab, CHAT_TAB_ID };
}
