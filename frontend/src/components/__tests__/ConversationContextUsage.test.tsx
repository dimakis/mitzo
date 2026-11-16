// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConversationContextUsage } from '../ConversationContextUsage';
import { installDialogStub } from './dialog-stub';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('reads each agent on opening, retains partial failures and retries without model calls', async () => {
  installDialogStub();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  let failed = true;
  const fetch = vi.fn(async (url: string) =>
    url.includes('/two/') && failed
      ? Response.json({}, { status: 503 })
      : Response.json({
          sessionId: url.includes('/one/') ? 'one' : 'two',
          contextUsage: {
            used: 5000,
            measuredAt: 1,
            limits: { model: 'reported', source: 'runtime', contextWindow: 10000, stale: false },
          },
        }),
  );
  vi.stubGlobal('fetch', fetch);
  render(
    <ConversationContextUsage
      participants={[
        { id: 'one', name: 'Architect' },
        { id: 'two', name: 'Reviewer' },
      ]}
    />,
  );
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Token usage' }));
  const dialog = screen.getByRole('dialog', { name: 'Context by agent' });
  expect(await within(dialog).findByText(/50%/)).toBeTruthy();
  expect(await within(dialog).findByRole('alert')).toHaveProperty(
    'textContent',
    expect.stringContaining('Context could not be read'),
  );
  expect(within(dialog).getByText('Reviewer')).toBeTruthy();
  failed = false;
  fireEvent.click(within(dialog).getByRole('button', { name: 'Refresh context' }));
  await waitFor(() => expect(within(dialog).getAllByRole('meter')).toHaveLength(2));
  expect(fetch.mock.calls.every(([url]) => url.endsWith('/context'))).toBe(true);
});
