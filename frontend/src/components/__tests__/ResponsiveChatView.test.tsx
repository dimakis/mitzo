// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ResponsiveChatView } from '../ResponsiveChatView';
import { useIsDesktop } from '../../hooks/useMediaQuery';
vi.mock('../../hooks/useMediaQuery', () => ({ useIsDesktop: vi.fn() }));
vi.mock('../../pages/DesktopChatView', () => ({ DesktopChatView: () => <div>Desktop chat</div> }));
vi.mock('../../pages/ChatView', () => ({ ChatView: () => <div>Mobile chat</div> }));
afterEach(cleanup);
it('switches the complete screen when the viewport crosses the mobile breakpoint', () => {
  vi.mocked(useIsDesktop).mockReturnValue(true);
  const { rerender } = render(<ResponsiveChatView />);
  expect(screen.getByText('Desktop chat')).toBeTruthy();
  vi.mocked(useIsDesktop).mockReturnValue(false);
  rerender(<ResponsiveChatView />);
  expect(screen.getByText('Mobile chat')).toBeTruthy();
  expect(screen.queryByText('Desktop chat')).toBeNull();
});
