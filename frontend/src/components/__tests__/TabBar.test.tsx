// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TabBar } from '../TabBar';
import type { Tab } from '../../hooks/useDesktopTabs';

afterEach(() => cleanup());

const CHAT_TAB_ID = 'chat';

const chatTab: Tab = { id: CHAT_TAB_ID, type: 'chat', label: 'Chat' };
const fileTab: Tab = {
  id: 'file:/src/a.ts',
  type: 'file',
  label: 'a.ts',
  filePath: '/src/a.ts',
};

describe('TabBar', () => {
  it('is hidden when there is only one tab', () => {
    const { container } = render(
      <TabBar
        tabs={[chatTab]}
        activeTabId={CHAT_TAB_ID}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        chatTabId={CHAT_TAB_ID}
      />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders all tabs', () => {
    render(
      <TabBar
        tabs={[chatTab, fileTab]}
        activeTabId={CHAT_TAB_ID}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        chatTabId={CHAT_TAB_ID}
      />,
    );
    expect(screen.getByText('Chat')).toBeTruthy();
    expect(screen.getByText('a.ts')).toBeTruthy();
  });

  it('applies active class to the active tab', () => {
    const { container } = render(
      <TabBar
        tabs={[chatTab, fileTab]}
        activeTabId={fileTab.id}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        chatTabId={CHAT_TAB_ID}
      />,
    );
    const items = container.querySelectorAll('.tab-bar-item');
    expect(items[0].classList.contains('tab-bar-item--active')).toBe(false);
    expect(items[1].classList.contains('tab-bar-item--active')).toBe(true);
  });

  it('does not show close button on chat tab', () => {
    const { container } = render(
      <TabBar
        tabs={[chatTab, fileTab]}
        activeTabId={CHAT_TAB_ID}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        chatTabId={CHAT_TAB_ID}
      />,
    );
    const closeButtons = container.querySelectorAll('.tab-bar-close');
    // Only file tab has a close button
    expect(closeButtons).toHaveLength(1);
  });

  it('close button fires onClose with stopPropagation', () => {
    const onClose = vi.fn();
    const onActivate = vi.fn();
    const { container } = render(
      <TabBar
        tabs={[chatTab, fileTab]}
        activeTabId={CHAT_TAB_ID}
        onActivate={onActivate}
        onClose={onClose}
        chatTabId={CHAT_TAB_ID}
      />,
    );
    const closeBtn = container.querySelector('.tab-bar-close') as HTMLElement;
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledWith(fileTab.id);
    // The parent onActivate should not fire (stopPropagation)
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('calls onActivate when a tab is clicked', () => {
    const onActivate = vi.fn();
    render(
      <TabBar
        tabs={[chatTab, fileTab]}
        activeTabId={CHAT_TAB_ID}
        onActivate={onActivate}
        onClose={vi.fn()}
        chatTabId={CHAT_TAB_ID}
      />,
    );
    fireEvent.click(screen.getByText('a.ts'));
    expect(onActivate).toHaveBeenCalledWith(fileTab.id);
  });
});
