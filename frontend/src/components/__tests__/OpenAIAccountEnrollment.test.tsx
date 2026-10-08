// @vitest-environment jsdom
import { act } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OpenAIAccountEnrollment } from '../OpenAIAccountEnrollment';
import * as api from '../../lib/connections-api';

vi.mock('../../lib/connections-api', () => ({
  getOpenAIAccounts: vi.fn(),
  enrollOpenAIAccount: vi.fn(),
}));
const account = { id: 'work-new', label: 'Work API', projectLabel: 'Research', state: 'ready' };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getOpenAIAccounts).mockResolvedValue({ enabled: true, accounts: [] });
  vi.mocked(api.enrollOpenAIAccount).mockResolvedValue(account);
});
afterEach(cleanup);
async function mount(authorized = true) {
  const onReauthorizationNeeded = vi.fn();
  const view = render(
    <OpenAIAccountEnrollment
      csrf="csrf"
      authorized={authorized}
      onReauthorizationNeeded={onReauthorizationNeeded}
    />,
  );
  await act(async () => {});
  return { ...view, onReauthorizationNeeded };
}
function fill() {
  fireEvent.change(screen.getByLabelText('Account label'), { target: { value: 'Work API' } });
  fireEvent.change(screen.getByLabelText('Intended work project name'), {
    target: { value: 'Research' },
  });
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'PRIVATE_KEY' } });
}
it('requires browser reauthorization before accepting a new key', async () => {
  const f = await mount(false);
  expect(screen.queryByLabelText('API key')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm identity to add an account' }));
  expect(f.onReauthorizationNeeded).toHaveBeenCalledOnce();
  expect(api.enrollOpenAIAccount).not.toHaveBeenCalled();
});
it('requires billing consent, submits one masked key, and clears it before awaiting validation', async () => {
  let resolve!: (value: typeof account) => void;
  vi.mocked(api.enrollOpenAIAccount).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await mount();
  fill();
  expect((screen.getByLabelText('API key') as HTMLInputElement).type).toBe('password');
  expect(
    (screen.getByRole('button', { name: 'Validate and add account' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.getByText(/gpt-6-luna/).textContent).toContain('newly entered key');
  fireEvent.click(screen.getByRole('checkbox'));
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Validate and add account' })),
  );
  expect(api.enrollOpenAIAccount).toHaveBeenCalledWith({
    csrf: 'csrf',
    label: 'Work API',
    projectLabel: 'Research',
    apiKey: 'PRIVATE_KEY',
    billingConfirmed: true,
    requestId: expect.any(String),
  });
  expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('');
  await act(async () => resolve(account));
  expect(screen.getByText('Work API is ready for new chats.')).toBeTruthy();
  expect(screen.getByText(/Existing tasks keep their current account/)).toBeTruthy();
});
it('keeps a failed attempt in review without automatically resubmitting or leaking diagnostics', async () => {
  vi.mocked(api.enrollOpenAIAccount).mockRejectedValue(new Error('Bearer PRIVATE_KEY'));
  await mount();
  fill();
  fireEvent.click(screen.getByRole('checkbox'));
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Validate and add account' })),
  );
  expect(api.enrollOpenAIAccount).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: 'Validate and add account' })).toBeNull();
  expect(document.body.textContent).not.toContain('PRIVATE_KEY');
  expect(api.getOpenAIAccounts).toHaveBeenCalledTimes(2);
});
it('shows unavailable enrollment for a stale route', async () => {
  vi.mocked(api.getOpenAIAccounts).mockResolvedValue({ enabled: false, accounts: [] });
  await mount();
  expect(screen.getByText('Adding OpenAI API accounts is unavailable.')).toBeTruthy();
  expect(screen.queryByLabelText('API key')).toBeNull();
});
it('allows a new deliberate operation only after its failed validation is confirmed', async () => {
  vi.mocked(api.enrollOpenAIAccount).mockImplementation(async (input) => ({
    ...account,
    requestId: input.requestId,
    state: 'failed',
  }));
  vi.mocked(api.getOpenAIAccounts).mockImplementation(async () => ({
    enabled: true,
    accounts: vi.mocked(api.enrollOpenAIAccount).mock.calls.length
      ? [
          {
            ...account,
            requestId: vi.mocked(api.enrollOpenAIAccount).mock.calls[0][0].requestId,
            state: 'failed',
          },
        ]
      : [],
  }));
  await mount();
  fill();
  fireEvent.click(screen.getByRole('checkbox'));
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Validate and add account' })),
  );
  const firstId = vi.mocked(api.enrollOpenAIAccount).mock.calls[0][0].requestId;
  fireEvent.click(screen.getByRole('button', { name: 'Try a new key' }));
  fill();
  fireEvent.click(screen.getByRole('checkbox'));
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Validate and add account' })),
  );
  expect(vi.mocked(api.enrollOpenAIAccount).mock.calls[1][0].requestId).not.toBe(firstId);
});
it('clears an entered key when authorization is lost and when the form unmounts', async () => {
  const f = await mount();
  fill();
  f.rerender(
    <OpenAIAccountEnrollment csrf="" authorized={false} onReauthorizationNeeded={vi.fn()} />,
  );
  f.rerender(<OpenAIAccountEnrollment csrf="fresh" authorized onReauthorizationNeeded={vi.fn()} />);
  expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('');
  fill();
  f.unmount();
  await mount();
  expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('');
});
it.each(['connecting', 'needs_attention'])(
  'blocks fresh setup after reload while another enrollment is %s',
  async (state) => {
    vi.mocked(api.getOpenAIAccounts).mockResolvedValue({
      enabled: true,
      accounts: [{ ...account, requestId: 'previous-browser-request', state }],
    });
    await mount();
    expect(screen.queryByLabelText('API key')).toBeNull();
    expect(screen.getByText(/previous enrollment must be reviewed/)).toBeTruthy();
    expect(api.enrollOpenAIAccount).not.toHaveBeenCalled();
  },
);
it('allows a fresh setup when previous enrollments are ready or failed', async () => {
  vi.mocked(api.getOpenAIAccounts).mockResolvedValue({
    enabled: true,
    accounts: [account, { ...account, id: 'failed', state: 'failed' }],
  });
  await mount();
  expect(screen.getByLabelText('API key')).toBeTruthy();
});
