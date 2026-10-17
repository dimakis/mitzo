// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SandboxBatchCleanup } from '../SandboxBatchCleanup';
import { readApiJson } from '../../lib/api-json-read';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../HomeDialog', () => ({
  HomeDialog: ({ children, title }: { children: ReactNode; title: string }) => (
    <section role="dialog" aria-label={title}>
      {children}
    </section>
  ),
}));
vi.mock('../../lib/api-json-read', () => ({ readApiJson: vi.fn() }));
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
const item = {
  conversationId: 'chat',
  sandboxName: 'sandbox',
  physicalId: 'physical',
  state: 'stopped',
  title: 'Completed comparison',
  account: 'Work',
  canReviewCleanup: true,
};
const preview = {
  token: 'token',
  action: 'delete',
  blockers: [],
  record: { conversationId: 'chat', sandboxName: 'sandbox', physicalSandboxId: 'physical' },
};
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});
function mount(items = [item]) {
  const changed = vi.fn();
  render(<SandboxBatchCleanup items={items} onClose={() => {}} onChanged={changed} />);
  return changed;
}
it('requires a review and acknowledgement, rechecks before each write, and reports confirmed results', async () => {
  vi.mocked(readApiJson).mockResolvedValue(preview);
  vi.mocked(apiFetch).mockResolvedValue(new Response('{"action":"deleted"}', { status: 200 }));
  const changed = mount();
  await screen.findByText('Ready to delete');
  expect(apiFetch).not.toHaveBeenCalled();
  expect(
    screen.getByRole('button', { name: 'Delete reviewed sandboxes' }).hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Delete reviewed sandboxes' }));
  await screen.findByText('Deleted; chat and checkpoint retained');
  expect(readApiJson).toHaveBeenCalledTimes(2);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(JSON.parse(vi.mocked(apiFetch).mock.calls[0][1]!.body as string)).toEqual({
    token: 'token',
  });
});
it('blocks every write when a selected resource cannot be reviewed', async () => {
  vi.mocked(readApiJson).mockResolvedValue({
    ...preview,
    action: 'none',
    blockers: ['active_session'],
  });
  mount();
  await screen.findByText(/active session/i);
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(apiFetch).not.toHaveBeenCalled();
});
it('rejects a replacement physical ID observed between review and confirmation', async () => {
  vi.mocked(readApiJson)
    .mockResolvedValueOnce(preview)
    .mockResolvedValue({
      ...preview,
      record: { ...preview.record, physicalSandboxId: 'replacement' },
    });
  mount();
  await screen.findByText('Ready to delete');
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Delete reviewed sandboxes' }));
  await screen.findByText(/identity changed/i);
  expect(apiFetch).not.toHaveBeenCalled();
});
it('stops after an uncertain deletion and does not submit the remaining batch', async () => {
  const second = {
    ...item,
    conversationId: 'second',
    sandboxName: 'second',
    physicalId: 'second',
    title: 'Second chat',
  };
  vi.mocked(readApiJson).mockImplementation(async (path) =>
    path.includes('second')
      ? {
          ...preview,
          record: { conversationId: 'second', sandboxName: 'second', physicalSandboxId: 'second' },
        }
      : preview,
  );
  vi.mocked(apiFetch).mockRejectedValue(Error('Connection lost'));
  const changed = mount([item, second]);
  await screen.findAllByText('Ready to delete');
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Delete reviewed sandboxes' }));
  await screen.findByText(/Outcome unverified/);
  expect(apiFetch).toHaveBeenCalledTimes(1);
  expect(changed).toHaveBeenCalledTimes(1);
});

it.each(['headers', 'body'])(
  'bounds a stalled confirmation %s, refreshes and unlocks without replaying',
  async (stage) => {
    const second = {
      ...item,
      conversationId: 'second',
      sandboxName: 'second',
      physicalId: 'second',
    };
    vi.mocked(readApiJson).mockImplementation(async (path) => ({
      ...preview,
      record: path.includes('second')
        ? { conversationId: 'second', sandboxName: 'second', physicalSandboxId: 'second' }
        : preview.record,
    }));
    const never = new Promise<never>(() => {});
    const response = new Response('{}');
    vi.spyOn(response, 'json').mockReturnValue(never);
    vi.mocked(apiFetch).mockImplementation(() =>
      stage === 'headers' ? never : Promise.resolve(response),
    );
    const changed = mount([item, second]);
    await screen.findAllByText('Ready to delete');
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete reviewed sandboxes' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(screen.getByText(/Outcome unverified/)).toBeTruthy();
    expect(screen.getByText(/Not attempted/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Done' }).hasAttribute('disabled')).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(apiFetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
  },
);
