// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ResponsiveChatView } from '../ResponsiveChatView';
import { AddReviewerSheet } from '../AddReviewerSheet';
import { useIsDesktop } from '../../hooks/useMediaQuery';
vi.mock('../../hooks/useMediaQuery', () => ({ useIsDesktop: vi.fn() }));
vi.mock('../../pages/DesktopChatView', () => ({
  DesktopChatView: () => (
    <div>
      Desktop chat
      <AddReviewerSheet sessionId="session" />
    </div>
  ),
}));
vi.mock('../../pages/ChatView', () => ({
  ChatView: () => (
    <div>
      Mobile chat
      <AddReviewerSheet sessionId="session" />
    </div>
  ),
}));
vi.mock('@mitzo/client/hooks', () => ({ useMitzoStore: () => 'session' }));
vi.mock('../../lib/api-fetch', () => ({
  apiFetch: async () =>
    new Response(JSON.stringify({ config: null, seats: [], runtimeAvailable: false })),
}));
vi.mock('../SymposiumProfilePicker', () => ({ SymposiumProfilePicker: () => null }));
vi.mock('../AccountModelPicker', () => ({ AccountModelPicker: () => null }));
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

it('keeps the shared reviewer draft open across desktop/mobile wrapper changes', async () => {
  vi.mocked(useIsDesktop).mockReturnValue(true);
  const { rerender } = render(<ResponsiveChatView />);
  fireEvent.click(screen.getByRole('button', { name: 'Add reviewer' }));
  fireEvent.change(screen.getByLabelText('Review package'), {
    target: { value: 'Preserve this review package' },
  });
  vi.mocked(useIsDesktop).mockReturnValue(false);
  rerender(<ResponsiveChatView />);
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect((screen.getByLabelText('Review package') as HTMLTextAreaElement).value).toBe(
    'Preserve this review package',
  );
  expect(screen.getAllByRole('button', { name: 'Add reviewer' })).toHaveLength(1);
});
