// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { apiFetch } from '../../lib/api-fetch';
import { SymposiumPublication } from '../SymposiumPublication';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.resetAllMocks();
});
const response = (body: unknown) => ({ ok: true, json: async () => body }) as Response;
it('keeps native review prerequisites explicit without fabricating a record', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response({ available: true, credentials: [] }));
  render(<SymposiumPublication sessionId="session" record={null} />);
  expect(await screen.findByText(/trusted review record and completed artifact seal/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Create PR' })).toBeNull();
});
it('requires principal preview and a separate grant before requesting normal approval', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    const path = String(url);
    if (path.endsWith('/select'))
      return response({
        connectionId: 'write',
        connectionRevision: 1,
        credentialGeneration: 'generation',
      });
    if (path.endsWith('/artifact'))
      return response({
        recordId: 'record',
        recordHash: 'a'.repeat(64),
        sealId: 'seal',
        sealHash: 'b'.repeat(64),
        commit: 'commit',
      });
    if (path.endsWith('/preview'))
      return response({ principal: { host: 'github.com', numericId: 42, login: 'selected-user' } });
    if (path.endsWith('/grant')) return response({ id: 'grant', bindingHash: 'c'.repeat(64) });
    if (path.endsWith('/publish'))
      return response({
        status: 'succeeded',
        externalResultId: 'https://github.com/owner/repo/pull/1',
      });
    return response({
      available: true,
      credentials: [{ id: 'write', label: 'Write account', revision: 1 }],
    });
  });
  render(
    <SymposiumPublication sessionId="session" record={{ id: 'record', hash: 'a'.repeat(64) }} />,
  );
  fireEvent.change(await screen.findByLabelText('Publication credential'), {
    target: { value: 'write' },
  });
  fireEvent.change(screen.getByLabelText('Repository'), { target: { value: 'owner/repo' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview selected account' }));
  expect(await screen.findByText(/selected-user.*42/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Create PR' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Use this account and artifact' }));
  fireEvent.change(screen.getByLabelText('PR title'), { target: { value: 'Reviewed change' } });
  fireEvent.click(await screen.findByRole('button', { name: 'Create PR' }));
  expect(await screen.findByRole('link', { name: 'Open pull request' })).toBeTruthy();
  const call = vi.mocked(apiFetch).mock.calls.find(([url]) => String(url).endsWith('/publish'))!;
  expect(JSON.parse(String(call[1]?.body)).body).toContain('Review record: record');
});

it('retains the exact publication operation for recovery after remount', async () => {
  const saved = {
    grantId: 'grant',
    bindingHash: 'c'.repeat(64),
    turnId: 'same-turn',
    idempotencyKey: 'same-key',
    baseBranch: 'main',
    title: 'Reviewed',
    body: 'Exact reviewed body',
    draft: true,
  };
  sessionStorage.setItem('mitzo-publication:session:record', JSON.stringify(saved));
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    response(
      String(url).endsWith('/publish')
        ? { status: 'verification_pending' }
        : { available: true, credentials: [] },
    ),
  );
  render(
    <SymposiumPublication sessionId="session" record={{ id: 'record', hash: 'a'.repeat(64) }} />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Check publication result' }));
  await screen.findByText('verification_pending');
  const call = vi.mocked(apiFetch).mock.calls.find(([url]) => String(url).endsWith('/publish'))!;
  expect(JSON.parse(String(call[1]?.body))).toEqual(saved);
});

it.each(['failed', 'cancelled', 'denied'])(
  'releases terminal %s identity and requires a fresh selection',
  async (status) => {
    const key = 'mitzo-publication:session:record';
    sessionStorage.setItem(
      key,
      JSON.stringify({
        grantId: 'grant',
        bindingHash: 'c'.repeat(64),
        turnId: 'old-turn',
        idempotencyKey: 'old-key',
        baseBranch: 'main',
        title: 'Reviewed',
        body: 'Reviewed body',
        draft: true,
      }),
    );
    vi.mocked(apiFetch).mockImplementation(async (url) =>
      response(
        String(url).endsWith('/publish')
          ? { status }
          : {
              available: true,
              credentials: [{ id: 'write', label: 'Write account', revision: 1 }],
            },
      ),
    );
    render(
      <SymposiumPublication sessionId="session" record={{ id: 'record', hash: 'a'.repeat(64) }} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Check publication result' }));
    await screen.findByText(status);
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check publication result' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create PR' })).toBeNull();
    expect(
      (screen.getByLabelText('Publication credential').closest('fieldset') as HTMLFieldSetElement)
        .disabled,
    ).toBe(false);
  },
);
