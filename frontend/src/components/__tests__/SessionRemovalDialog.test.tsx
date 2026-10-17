// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionRemovalDialog } from '../SessionRemovalDialog';
import { readApiJson } from '../../lib/api-json-read';
vi.mock('../../lib/api-json-read', () => ({ readApiJson: vi.fn() }));
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it('reviews without mutation, then explicitly releases or archives with different payloads', async () => {
  vi.mocked(readApiJson).mockResolvedValue({
    sandbox: { action: 'stop_and_delete', token: 'review', blockers: [] },
  });
  const remove = vi.fn(async () => true);
  render(<SessionRemovalDialog sessionId="c" onRemove={remove} onClose={() => {}} />);
  await screen.findByRole('button', { name: 'Delete chat and sandbox' });
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Delete chat and sandbox' }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith({ cleanupToken: 'review' }));
});
it('keeps Archive available when active work blocks sandbox deletion', async () => {
  vi.mocked(readApiJson).mockResolvedValue({
    sandbox: { action: 'none', blockers: ['active_session'] },
  });
  const remove = vi.fn(async () => true);
  render(<SessionRemovalDialog sessionId="c" onRemove={remove} onClose={() => {}} />);
  await screen.findByText(/active session/i);
  expect(
    (screen.getByRole('button', { name: 'Delete chat and sandbox' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Archive chat' }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith({ archive: true }));
});
it('retains the dialog on a refused deletion and requires a fresh review', async () => {
  vi.mocked(readApiJson).mockResolvedValue({
    sandbox: { action: 'delete', token: 'review', blockers: [] },
  });
  const close = vi.fn();
  render(<SessionRemovalDialog sessionId="c" onRemove={async () => false} onClose={close} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Delete chat and sandbox' }));
  await screen.findByRole('alert');
  expect(close).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: 'Delete chat' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});
