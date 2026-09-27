// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { apiFetch } from '../../lib/api-fetch';
import { SymposiumPublicationRecovery } from '../SymposiumPublicationRecovery';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const response = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
const record = { id: 'record', hash: 'a'.repeat(64) };
const operation = {
  operationId: 'operation',
  grantId: 'original-grant',
  bindingHash: 'b'.repeat(64),
  sessionId: 'session',
  connectionId: 'credential',
  connectionRevision: 7,
  credentialGeneration: 'original-generation',
  repository: 'owner/repo',
  recordId: record.id,
  recordHash: record.hash,
  sealId: 'seal',
  sealHash: 'c'.repeat(64),
  principal: { host: 'github.com', numericId: 42, login: 'original-principal' },
};
function mount() {
  const onUncertain = vi.fn(),
    onRecovered = vi.fn();
  render(
    <SymposiumPublicationRecovery
      sessionId="session"
      record={record}
      onUncertain={onUncertain}
      onRecovered={onRecovered}
    />,
  );
  return { onUncertain, onRecovered };
}
async function select() {
  fireEvent.change(await screen.findByLabelText('Uncertain publication'), {
    target: { value: operation.operationId },
  });
  fireEvent.change(screen.getByLabelText('App passphrase for read-only recovery'), {
    target: { value: 'synthetic-passphrase' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Verify selected operation — no writes' }));
}
it('selects an exact server operation and fresh-authenticates before a read-only recovery, without selecting credentials or publishing', async () => {
  let recovered = false;
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (String(url).includes('/recovery?'))
      return response({ operations: recovered ? [] : [operation] });
    if (String(url).endsWith('/reauthorize'))
      return response({ csrf: 'fresh-csrf', expiresAt: Date.now() + 60000 });
    recovered = true;
    return response({ id: operation.operationId, status: 'succeeded' });
  });
  const callbacks = mount();
  await select();
  await screen.findByText('Original publication verified. No write was repeated.');
  expect(callbacks.onRecovered).toHaveBeenCalledOnce();
  const calls = vi.mocked(apiFetch).mock.calls;
  expect(String(calls[0][0])).toContain('recordId=record&recordHash=' + record.hash);
  expect(
    calls
      .filter(([, options]) => options?.method === 'POST')
      .map(([url]) => String(url).split('/publication')[1]),
  ).toEqual(['/recovery/reauthorize', '/recovery']);
  const call = calls.find(([url]) => String(url).endsWith('/recovery'))!;
  const selection = Object.fromEntries(
    Object.entries(operation).filter(([key]) => !['sessionId', 'principal'].includes(key)),
  );
  expect(JSON.parse(String(call[1]?.body))).toEqual(selection);
  expect(new Headers(call[1]?.headers).get('X-CSRF-Token')).toBe('fresh-csrf');
});
it.each(['sessionId', 'recordId', 'recordHash'])(
  'rejects a candidate from another %s',
  async (field) => {
    vi.mocked(apiFetch).mockResolvedValue(
      response({ operations: [{ ...operation, [field]: 'different' }] }),
    );
    const callbacks = mount();
    await screen.findByText(/Pending publication status is unavailable/);
    expect(screen.queryByLabelText('Uncertain publication')).toBeNull();
    expect(callbacks.onUncertain).not.toHaveBeenCalledWith(false);
  },
);
it.each(['denied', 'expired'])('does not recover after %s fresh authentication', async (kind) => {
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    String(url).includes('/recovery?')
      ? response({ operations: [operation] })
      : response({ csrf: 'csrf', expiresAt: Date.now() - 1 }, kind !== 'denied'),
  );
  const callbacks = mount();
  await select();
  await vi.waitFor(() =>
    expect(
      (screen.getByLabelText('App passphrase for read-only recovery') as HTMLInputElement).value,
    ).toBe(''),
  );
  expect(callbacks.onRecovered).not.toHaveBeenCalled();
  expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).endsWith('/recovery'))).toBe(
    false,
  );
});
it('fails closed on missing recovery status rather than enabling a new write', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response({ available: true }));
  const callbacks = mount();
  await screen.findByText(/Pending publication status is unavailable/);
  expect(callbacks.onUncertain).not.toHaveBeenCalledWith(false);
});
it('does not continue an old authentication response after the displayed record changes', async () => {
  let release!: (value: unknown) => void;
  const delayed = new Promise((resolve) => {
    release = resolve;
  });
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (String(url).includes('/recovery?')) return response({ operations: [operation] });
    return { ok: true, json: () => delayed } as Response;
  });
  const onUncertain = vi.fn();
  const view = render(
    <SymposiumPublicationRecovery
      sessionId="session"
      record={record}
      onUncertain={onUncertain}
      onRecovered={vi.fn()}
    />,
  );
  await select();
  await vi.waitFor(() =>
    expect(
      vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).endsWith('/reauthorize')),
    ).toBe(true),
  );
  view.rerender(
    <SymposiumPublicationRecovery
      sessionId="session"
      record={{ id: 'different', hash: 'd'.repeat(64) }}
      onUncertain={onUncertain}
      onRecovered={vi.fn()}
    />,
  );
  release({ csrf: 'old-csrf', expiresAt: Date.now() + 60000 });
  await screen.findByText(/Pending publication status is unavailable/);
  expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).endsWith('/recovery'))).toBe(
    false,
  );
});
