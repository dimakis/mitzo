// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionRemovalDialog } from '../SessionRemovalDialog';
import { readApiJson } from '../../lib/api-json-read';
import { sessionRemovalAction } from '../../lib/session-removal-action';
vi.mock('../../lib/api-json-read', () => ({ readApiJson: vi.fn() }));
vi.mock('../../lib/session-removal-action', () => ({ sessionRemovalAction: vi.fn() }));
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
  expect(
    (screen.getByRole('button', { name: 'Delete chat and sandbox' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(readApiJson).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Review again' }));
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Delete chat and sandbox' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
});
it('stops and reviews the runtime before offering explicit deletion', async () => {
  vi.mocked(readApiJson).mockResolvedValue({
    sandbox: { action: 'none', blockers: ['active_session'] },
    needsPreparation: true,
    removal: null,
  });
  vi.mocked(sessionRemovalAction).mockResolvedValue({
    sandbox: { action: 'stop_and_delete', token: 'fresh', blockers: [] },
    needsPreparation: false,
    removal: { operationId: 'original', phase: 'closing', canKeep: true },
  });
  const remove = vi.fn(async () => true);
  render(<SessionRemovalDialog sessionId="c" onRemove={remove} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Stop and review deletion' }));
  await waitFor(() =>
    expect(sessionRemovalAction).toHaveBeenCalledWith(
      '/api/sessions/c/prepare-deletion',
      {},
      expect.any(AbortSignal),
    ),
  );
  expect(remove).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole('button', { name: 'Delete chat and sandbox' }));
  await waitFor(() =>
    expect(remove).toHaveBeenCalledWith({ cleanupToken: 'fresh', removalOperationId: 'original' }),
  );
});
it('shows retained local disk use and keeps a failed preparation recoverable', async () => {
  vi.mocked(readApiJson).mockResolvedValue({
    sandbox: null,
    needsPreparation: true,
    removal: { operationId: 'original', phase: 'failed', canKeep: true },
    localWorkspace: {
      action: 'retain',
      reason: 'This workspace remains; disk space is not reclaimed.',
    },
  });
  vi.mocked(sessionRemovalAction).mockResolvedValue({ ok: true });
  const close = vi.fn();
  render(<SessionRemovalDialog sessionId="c" onRemove={async () => true} onClose={close} />);
  await screen.findByText(/disk space/);
  fireEvent.click(screen.getByRole('button', { name: 'Keep chat' }));
  await waitFor(() =>
    expect(sessionRemovalAction).toHaveBeenCalledWith(
      '/api/sessions/c/keep-chat',
      { removalOperationId: 'original' },
      expect.any(AbortSignal),
    ),
  );
  expect(close).toHaveBeenCalled();
});

it('refreshes a failed stop without losing its original Keep chat action or replaying the stop', async () => {
  vi.mocked(readApiJson)
    .mockResolvedValueOnce({ sandbox: null, needsPreparation: true, removal: null })
    .mockResolvedValueOnce({
      sandbox: null,
      needsPreparation: true,
      removal: {
        operationId: 'failed-stop',
        phase: 'failed',
        canKeep: true,
        error: 'A tool call has no verified result. Open the chat to review unfinished work.',
      },
    });
  vi.mocked(sessionRemovalAction).mockRejectedValueOnce(
    Error('A tool call has no verified result.'),
  );
  const remove = vi.fn(async () => true);
  const close = vi.fn();
  render(<SessionRemovalDialog sessionId="c" onRemove={remove} onClose={close} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Stop and review deletion' }));
  const keep = await screen.findByRole('button', { name: 'Keep chat' });
  expect(screen.getByRole('alert').textContent).toContain('tool call');
  expect((screen.getByRole('button', { name: 'Delete chat' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(sessionRemovalAction).toHaveBeenCalledTimes(1);
  expect(remove).not.toHaveBeenCalled();
  vi.mocked(sessionRemovalAction).mockResolvedValueOnce({ ok: true });
  fireEvent.click(keep);
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(sessionRemovalAction).toHaveBeenLastCalledWith(
    '/api/sessions/c/keep-chat',
    { removalOperationId: 'failed-stop' },
    expect.any(AbortSignal),
  );
});

it('retains failed-removal details across an unavailable review and disables stale mutation controls', async () => {
  vi.mocked(readApiJson)
    .mockResolvedValueOnce({
      sandbox: null,
      needsPreparation: true,
      removal: {
        operationId: 'original',
        phase: 'failed',
        canKeep: true,
        error: 'Recovery needs review.',
      },
    })
    .mockRejectedValueOnce(Error('offline'));
  render(<SessionRemovalDialog sessionId="c" onRemove={async () => true} onClose={() => {}} />);
  await screen.findByRole('button', { name: 'Keep chat' });
  expect(screen.getByRole('alert').textContent).toContain('Recovery needs review');
  fireEvent.click(screen.getByRole('button', { name: 'Review again' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Couldn’t review'));
  expect((screen.getByRole('button', { name: 'Keep chat' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(
    (screen.getByRole('button', { name: 'Stop and review deletion' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect((screen.getByRole('button', { name: 'Archive chat' }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  expect(sessionRemovalAction).not.toHaveBeenCalled();
});
