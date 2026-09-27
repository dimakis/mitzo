// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '../../lib/api-fetch';
import { SymposiumSubscriptionLogin } from '../SymposiumSubscriptionLogin';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const response = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;

it('requires an explicit ready callback transport and only exposes the official auth URL', async () => {
  vi.mocked(apiFetch).mockImplementation(async (_url, init) =>
    init?.method === 'POST'
      ? response({
          attemptId: 'attempt',
          authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=fake',
        })
      : response({ state: 'pending', attemptId: 'attempt' }),
  );
  render(<SymposiumSubscriptionLogin onComplete={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect personal subscription' }));
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  expect(
    (screen.getByRole('button', { name: 'Start personal login' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(screen.getByText(/A phone cannot complete/)).toBeTruthy();
  fireEvent.click(screen.getByLabelText('Browser on another computer with SSH'));
  expect(screen.getByText(/ssh -N -o ExitOnForwardFailure/)).toBeTruthy();
  fireEvent.click(screen.getByLabelText('The callback setup is ready on the browser computer'));
  fireEvent.click(screen.getByRole('button', { name: 'Start personal login' }));
  const link = await screen.findByRole('link', { name: 'Open official OpenAI login' });
  expect(link.getAttribute('href')).toBe('https://auth.openai.com/oauth/authorize?state=fake');
  expect(apiFetch).toHaveBeenCalledWith(
    '/api/symposium/personal/login',
    expect.objectContaining({ body: JSON.stringify({ callbackTransport: 'ssh-forwarded' }) }),
  );
});

it.each([
  'https://evil.example/auth',
  'https://auth.openai.com.evil.example/oauth/authorize',
  'http://auth.openai.com/oauth/authorize',
])('rejects untrusted authorization URL %s', async (authorizationUrl) => {
  vi.mocked(apiFetch).mockResolvedValue(response({ attemptId: 'attempt', authorizationUrl }));
  render(<SymposiumSubscriptionLogin onComplete={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect personal subscription' }));
  fireEvent.click(screen.getByLabelText('Browser on the Mitzo server'));
  fireEvent.click(screen.getByLabelText('The callback setup is ready on the browser computer'));
  fireEvent.click(screen.getByRole('button', { name: 'Start personal login' }));
  await screen.findByRole('alert');
  expect(screen.queryByRole('link')).toBeNull();
});

it.each(['completed', 'failed', 'unknown'])(
  'shows definitive %s status without inferring success from accounts',
  async (state) => {
    vi.mocked(apiFetch).mockImplementation(async (_url, init) =>
      init?.method === 'POST'
        ? response({
            attemptId: 'attempt',
            authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=fake',
          })
        : response({ state, ...(state === 'unknown' ? {} : { attemptId: 'attempt' }) }),
    );
    const onComplete = vi.fn();
    render(<SymposiumSubscriptionLogin onComplete={onComplete} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect personal subscription' }));
    fireEvent.click(screen.getByLabelText('Browser on the Mitzo server'));
    fireEvent.click(screen.getByLabelText('The callback setup is ready on the browser computer'));
    fireEvent.click(screen.getByRole('button', { name: 'Start personal login' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/symposium/personal/login/status?attemptId=attempt',
        expect.any(Object),
      ),
    );
    if (state === 'completed') {
      await screen.findByText(/Login completed/);
      expect(onComplete).toHaveBeenCalledTimes(1);
    } else {
      await screen.findByRole('alert');
      expect(onComplete).not.toHaveBeenCalled();
    }
  },
);

it('recovers a pending receipt after remount without persisting or exposing an auth URL', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response({ state: 'pending', attemptId: 'existing' }));
  render(<SymposiumSubscriptionLogin onComplete={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect personal subscription' }));
  await screen.findByText(/Continue in the already-open login browser/);
  expect(screen.queryByRole('link')).toBeNull();
  expect(
    (screen.getByRole('button', { name: 'Start personal login' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/symposium/personal/login/status?attemptId=existing',
      expect.any(Object),
    ),
  );
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('does not count a historical completed receipt as completion of a new login', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response({ state: 'completed', attemptId: 'old' }));
  const onComplete = vi.fn();
  render(<SymposiumSubscriptionLogin onComplete={onComplete} />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect personal subscription' }));
  await screen.findByText(/Previous login completed/);
  expect(onComplete).not.toHaveBeenCalled();
});

it('refreshes the catalog for a recovered completed receipt without claiming a new login', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response({ state: 'completed', attemptId: 'old' }));
  const onComplete = vi.fn();
  const onCatalogRefresh = vi.fn();
  render(
    <SymposiumSubscriptionLogin onComplete={onComplete} onCatalogRefresh={onCatalogRefresh} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Connect personal subscription' }));
  await screen.findByText(/Previous login completed/);
  expect(onCatalogRefresh).toHaveBeenCalledTimes(1);
  expect(onComplete).not.toHaveBeenCalled();
});

it('retries initial receipt recovery in place and resumes pending polling', async () => {
  vi.mocked(apiFetch)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(response({ state: 'pending', attemptId: 'existing' }));
  render(<SymposiumSubscriptionLogin onComplete={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect personal subscription' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry status' }));
  await screen.findByText(/Continue in the already-open login browser/);
  await waitFor(() =>
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/symposium/personal/login/status?attemptId=existing',
      expect.any(Object),
    ),
  );
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it.each(['idle', 'unknown', 'failed'])(
  'unlocks setup when recovery retry returns %s',
  async (state) => {
    vi.mocked(apiFetch)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(response({ state }));
    render(<SymposiumSubscriptionLogin onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect personal subscription' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry status' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry status' })).toBeNull());
    fireEvent.click(screen.getByLabelText('Browser on the Mitzo server'));
    fireEvent.click(screen.getByLabelText('The callback setup is ready on the browser computer'));
    expect(
      (screen.getByRole('button', { name: 'Start personal login' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  },
);

it.each(['failed', 'unknown'])(
  'refreshes invalidated account choices when a login becomes %s',
  async (state) => {
    const changed = vi.fn();
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (init?.method === 'POST')
        return response({
          attemptId: 'attempt',
          authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=fake',
        });
      return response(
        url.includes('?attemptId=') ? { state, attemptId: 'attempt' } : { state: 'idle' },
      );
    });
    render(<SymposiumSubscriptionLogin onComplete={vi.fn()} onCatalogRefresh={changed} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect personal subscription' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    fireEvent.click(screen.getByLabelText('Browser on the Mitzo server'));
    fireEvent.click(screen.getByLabelText('The callback setup is ready on the browser computer'));
    fireEvent.click(screen.getByRole('button', { name: 'Start personal login' }));
    await screen.findByRole('alert');
    expect(changed).toHaveBeenCalled();
  },
);

it('keeps transport radio groups independent across simultaneous setup controls', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response({ state: 'idle' }));
  render(
    <>
      <SymposiumSubscriptionLogin onComplete={vi.fn()} />
      <SymposiumSubscriptionLogin onComplete={vi.fn()} />
    </>,
  );
  for (const button of screen.getAllByRole('button', { name: 'Connect personal subscription' }))
    fireEvent.click(button);
  const choices = screen.getAllByLabelText('Browser on the Mitzo server') as HTMLInputElement[];
  fireEvent.click(choices[0]);
  fireEvent.click(choices[1]);
  expect(choices[0].name).not.toBe(choices[1].name);
  expect(choices.every((choice) => choice.checked)).toBe(true);
});

it('invalidates old account choices as soon as a new callback attempt is allocated', async () => {
  const changed = vi.fn();
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (init?.method === 'POST')
      return response({
        attemptId: 'attempt',
        authorizationUrl: 'https://auth.openai.com/oauth/authorize?state=fake',
      });
    return response(
      url.includes('?attemptId=') ? { state: 'pending', attemptId: 'attempt' } : { state: 'idle' },
    );
  });
  render(<SymposiumSubscriptionLogin onComplete={vi.fn()} onCatalogRefresh={changed} />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect personal subscription' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalled());
  fireEvent.click(screen.getByLabelText('Browser on the Mitzo server'));
  fireEvent.click(screen.getByLabelText('The callback setup is ready on the browser computer'));
  fireEvent.click(screen.getByRole('button', { name: 'Start personal login' }));
  await screen.findByRole('link', { name: 'Open official OpenAI login' });
  expect(changed).toHaveBeenCalledOnce();
});

it.each(['conflict', 'lost'] as const)(
  'recovers an allocated login after an uncertain %s Start response',
  async (failure) => {
    let started = false;
    vi.mocked(apiFetch).mockImplementation(async (_url, init) => {
      if (init?.method === 'POST') {
        started = true;
        if (failure === 'lost') throw new Error('Response lost');
        return response({}, false);
      }
      return response(started ? { state: 'pending', attemptId: 'existing' } : { state: 'idle' });
    });
    render(<SymposiumSubscriptionLogin onComplete={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect personal subscription' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    fireEvent.click(screen.getByLabelText('Browser on the Mitzo server'));
    fireEvent.click(screen.getByLabelText('The callback setup is ready on the browser computer'));
    fireEvent.click(screen.getByRole('button', { name: 'Start personal login' }));
    await screen.findByText(/already-open|already open/i);
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/symposium/personal/login/status?attemptId=existing',
      expect.anything(),
    );
    expect(
      vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(1);
  },
);

it('keeps Retry status available if uncertain Start recovery also fails', async () => {
  let started = false;
  let recover = false;
  vi.mocked(apiFetch).mockImplementation(async (_url, init) => {
    if (init?.method === 'POST') {
      started = true;
      throw new Error('Lost');
    }
    if (started && !recover) throw new Error('Offline');
    return response(started ? { state: 'pending', attemptId: 'recovered' } : { state: 'idle' });
  });
  render(<SymposiumSubscriptionLogin onComplete={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Connect personal subscription' }));
  await waitFor(() => expect(apiFetch).toHaveBeenCalled());
  fireEvent.click(screen.getByLabelText('Browser on the Mitzo server'));
  fireEvent.click(screen.getByLabelText('The callback setup is ready on the browser computer'));
  fireEvent.click(screen.getByRole('button', { name: 'Start personal login' }));
  await screen.findByText(/Could not recover a login receipt/);
  recover = true;
  fireEvent.click(screen.getByRole('button', { name: 'Retry status' }));
  await screen.findByText(/already-open|already open/i);
  expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(
    1,
  );
});
