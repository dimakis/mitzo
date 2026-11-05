// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatApprovalQueue } from '../ChatApprovalQueue';
import { ApprovalDraftProvider } from '../ApprovalDraftProvider';
import { readApiJson } from '../../lib/api-json-read';
import type { PermissionRequest } from '../../types/chat';

vi.mock('../../lib/api-json-read', () => ({ readApiJson: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const first: PermissionRequest = {
  permId: 'first',
  sessionId: 'chat',
  toolName: 'AskUserQuestion',
  toolInput: '',
  questions: [
    { id: 'q', header: 'Choice', question: 'Which option?', options: [], multiSelect: false },
  ],
};
const second: PermissionRequest = {
  permId: 'second',
  sessionId: 'chat',
  toolName: 'Bash',
  toolInput: 'second-command',
};
const respond = vi.fn();
const props = {
  sessionId: 'chat',
  permission: first,
  permissionQueue: [second],
  ready: true,
  onPermissionRespond: respond,
};

it('opens the tapped second request, sends only its identity and waits for server confirmation', () => {
  const { rerender } = render(<ChatApprovalQueue {...props} requestedApprovalId="second" />);
  expect(screen.getByText('second-command')).toBeTruthy();
  expect(screen.getByLabelText('Pending approvals')).toHaveProperty('value', 'second');
  expect(screen.getByText('2 pending')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Allow Once' }));
  expect(respond).toHaveBeenCalledExactlyOnceWith('second', 'once', 'Bash');
  expect(screen.queryByText('Which option?')).toBeNull();
  rerender(<ChatApprovalQueue {...props} permissionQueue={[]} requestedApprovalId="second" />);
  expect(screen.getByText('Which option?')).toBeTruthy();
});

it('retains question drafts while switching requests and remounting the responsive screen', () => {
  const tree = (show: boolean) => (
    <ApprovalDraftProvider sessionId="chat" pendingIds={['first', 'second']}>
      {show && <ChatApprovalQueue {...props} />}
    </ApprovalDraftProvider>
  );
  const { rerender } = render(tree(true));
  fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Keep this answer' } });
  fireEvent.change(screen.getByLabelText('Pending approvals'), { target: { value: 'second' } });
  fireEvent.change(screen.getByLabelText('Pending approvals'), { target: { value: 'first' } });
  expect(screen.getByLabelText('Your answer')).toHaveProperty('value', 'Keep this answer');
  rerender(tree(false));
  rerender(tree(true));
  expect(screen.getByLabelText('Your answer')).toHaveProperty('value', 'Keep this answer');
  fireEvent.click(screen.getByRole('button', { name: 'Send answer' }));
  expect(respond).toHaveBeenLastCalledWith('first', 'once', 'AskUserQuestion', {
    q: ['Keep this answer'],
  });
});

it('explains a resolved deep link without showing a different approval', async () => {
  vi.mocked(readApiJson).mockResolvedValue({
    id: 'permission:old',
    sessionId: 'chat',
    resolution: 'deny',
  });
  render(<ChatApprovalQueue {...props} requestedApprovalId="old" />);
  expect(screen.queryByRole('button', { name: 'Allow Once' })).toBeNull();
  await screen.findByText('This request was already handled.');
  expect(screen.queryByText('Which option?')).toBeNull();
  expect(respond).not.toHaveBeenCalled();
  expect(readApiJson).toHaveBeenCalledWith(
    '/api/notifications/permission%3Aold',
    expect.any(AbortSignal),
  );
  fireEvent.change(screen.getByLabelText('Pending approvals'), { target: { value: 'second' } });
  expect(screen.getByText('second-command')).toBeTruthy();
});

it('never shows another session’s pending card while the selected chat is loading', () => {
  render(
    <ChatApprovalQueue
      {...props}
      sessionId="another-chat"
      ready={false}
      requestedApprovalId="second"
    />,
  );
  expect(screen.queryByText('second-command')).toBeNull();
  expect(screen.queryByText('Which option?')).toBeNull();
});

it('fences a late status read after navigating to another approval', async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(readApiJson).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { rerender } = render(<ChatApprovalQueue {...props} requestedApprovalId="old" />);
  rerender(<ChatApprovalQueue {...props} requestedApprovalId="second" />);
  finish({ id: 'permission:old', sessionId: 'chat', resolution: 'deny' });
  await waitFor(() => expect(screen.getByText('second-command')).toBeTruthy());
  expect(screen.queryByText('This request was already handled.')).toBeNull();
});

it('retains a submitted decision while switching cards so it cannot be submitted twice', () => {
  render(<ChatApprovalQueue {...props} requestedApprovalId="second" />);
  fireEvent.click(screen.getByRole('button', { name: 'Allow Once' }));
  fireEvent.change(screen.getByLabelText('Pending approvals'), { target: { value: 'first' } });
  fireEvent.change(screen.getByLabelText('Pending approvals'), { target: { value: 'second' } });
  expect(screen.getByRole('button', { name: 'Allow Once' })).toHaveProperty('disabled', true);
  expect(respond).toHaveBeenCalledTimes(1);
});

it.each([
  [{ resolution: 'expired' }, 'This request has expired.'],
  [{ expiresAt: 1 }, 'This request has expired.'],
  [{ sessionId: 'another' }, 'This request is not available in this chat.'],
])(
  'explains unavailable requests without substituting another card: %j',
  async (detail, message) => {
    vi.mocked(readApiJson).mockResolvedValue({
      id: 'permission:old',
      sessionId: 'chat',
      ...detail,
    });
    render(<ChatApprovalQueue {...props} requestedApprovalId="old" />);
    await screen.findByText(message);
    expect(screen.queryByRole('button', { name: 'Allow Once' })).toBeNull();
    expect(respond).not.toHaveBeenCalled();
  },
);
