// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDesktopTabs } from '../useDesktopTabs';

describe('useDesktopTabs', () => {
  it('starts with only the chat tab active', () => {
    const { result } = renderHook(() => useDesktopTabs());
    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0].type).toBe('chat');
    expect(result.current.activeTabId).toBe(result.current.CHAT_TAB_ID);
  });

  it('opens a file tab and activates it', () => {
    const { result } = renderHook(() => useDesktopTabs());
    act(() => result.current.openFileTab('/src/index.ts', 'index.ts'));
    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.activeTabId).toBe('file:/src/index.ts');
    const fileTab = result.current.tabs[1];
    expect(fileTab.type).toBe('file');
    if (fileTab.type === 'file') {
      expect(fileTab.filePath).toBe('/src/index.ts');
    }
  });

  it('opening a duplicate file tab is idempotent (no new tab)', () => {
    const { result } = renderHook(() => useDesktopTabs());
    act(() => result.current.openFileTab('/src/a.ts', 'a.ts'));
    act(() => result.current.openFileTab('/src/a.ts', 'a.ts'));
    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.activeTabId).toBe('file:/src/a.ts');
  });

  it('closing the active tab activates the neighbor', () => {
    const { result } = renderHook(() => useDesktopTabs());
    act(() => result.current.openFileTab('/a.ts', 'a.ts'));
    act(() => result.current.openFileTab('/b.ts', 'b.ts'));
    // Active is b.ts (last opened). Close it.
    act(() => result.current.closeTab('file:/b.ts'));
    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.activeTabId).toBe('file:/a.ts');
  });

  it('closing a non-active tab preserves the active tab', () => {
    const { result } = renderHook(() => useDesktopTabs());
    act(() => result.current.openFileTab('/a.ts', 'a.ts'));
    act(() => result.current.openFileTab('/b.ts', 'b.ts'));
    // Active is b.ts. Close a.ts.
    act(() => result.current.closeTab('file:/a.ts'));
    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.activeTabId).toBe('file:/b.ts');
  });

  it('chat tab cannot be closed', () => {
    const { result } = renderHook(() => useDesktopTabs());
    act(() => result.current.openFileTab('/a.ts', 'a.ts'));
    act(() => result.current.closeTab(result.current.CHAT_TAB_ID));
    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.tabs[0].type).toBe('chat');
  });

  it('activateChatTab resets to chat', () => {
    const { result } = renderHook(() => useDesktopTabs());
    act(() => result.current.openFileTab('/a.ts', 'a.ts'));
    expect(result.current.activeTabId).toBe('file:/a.ts');
    act(() => result.current.activateChatTab());
    expect(result.current.activeTabId).toBe(result.current.CHAT_TAB_ID);
  });
});
