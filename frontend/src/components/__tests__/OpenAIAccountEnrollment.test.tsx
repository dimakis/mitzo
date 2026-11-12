// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OpenAIAccountEnrollment } from '../OpenAIAccountEnrollment';
import * as api from '../../lib/connections-api';

vi.mock('../../lib/connections-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/connections-api')>()),
  getOpenAIAccounts: vi.fn(),
  enrollOpenAIAccount: vi.fn(),
  discoverApiModels: vi.fn(),
}));
const account = { id: 'work-new', label: 'Work API', projectLabel: 'Research', state: 'ready' };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getOpenAIAccounts).mockResolvedValue({ enabled: true, accounts: [] });
  vi.mocked(api.enrollOpenAIAccount).mockResolvedValue(account);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it.each(
  (['responses', 'messages'] as const).flatMap((protocol) =>
    (['secure', 'http'] as const).map((host) => ({ protocol, host })),
  ),
)(
  'allows a fresh corrected $protocol request after confirmed pre-enrollment rejection on $host hosts',
  async ({ protocol, host }) => {
    vi.stubGlobal(
      'crypto',
      host === 'secure'
        ? webcrypto
        : { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) },
    );
    vi.mocked(api.enrollOpenAIAccount).mockRejectedValueOnce(
      new api.OpenAIAccountEnrollmentFailure(true),
    );
    await mount();
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'enmaas' } });
    fireEvent.change(screen.getByLabelText('Model API'), { target: { value: protocol } });
    fireEvent.change(screen.getByLabelText('Additional model IDs'), {
      target: { value: 'vendor/model' },
    });
    fill();
    fireEvent.click(screen.getByRole('checkbox'));
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Save API account' })),
    );
    expect(api.enrollOpenAIAccount).toHaveBeenCalledOnce();
    const rejectedId = vi.mocked(api.enrollOpenAIAccount).mock.calls[0][0].requestId;
    expect(rejectedId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    expect(screen.getByRole('alert').textContent).toContain('rejected before enrollment');
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('Review enrollment status')).toBeNull();
    fireEvent.change(screen.getByLabelText('API base URL'), {
      target: { value: 'https://corrected.example/v1' },
    });
    fireEvent.change(screen.getByLabelText('Additional model IDs'), {
      target: { value: 'vendor/model' },
    });
    fill();
    fireEvent.click(screen.getByRole('checkbox'));
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Save API account' })),
    );
    expect(api.enrollOpenAIAccount).toHaveBeenCalledTimes(2);
    const corrected = vi.mocked(api.enrollOpenAIAccount).mock.calls[1][0];
    expect(corrected.requestId).not.toBe(rejectedId);
    expect(corrected.connection?.endpoint).toBe('https://corrected.example/v1');
    expect(corrected.connection?.protocol).toBe(protocol);
    if (protocol === 'messages') expect(corrected.connection?.authentication).toBe('bearer');
    expect(screen.getByText('Work API is ready for new chats.')).toBeTruthy();
  },
);
it.each(
  [
    'http://gateway.example/v1',
    'https://localhost/v1',
    'https://private.localhost/v1',
    'https://localhost./v1',
    'https://private.localhost./v1',
    'https://./v1',
    'https://gateway.example/' + '界'.repeat(500),
    'https://127.0.0.1/v1',
    'https://[::1]/v1',
    'https://user:password@gateway.example/v1',
    'https://gateway.example/v1?',
    'https://gateway.example/v1#',
  ].flatMap((endpoint) =>
    (['responses', 'messages'] as const).map((protocol) => ({ endpoint, protocol })),
  ),
)(
  'keeps an invalid $protocol provider endpoint editable without sending its key: $endpoint',
  async ({ endpoint, protocol }) => {
    await mount();
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'enmaas' } });
    fireEvent.change(screen.getByLabelText('Model API'), { target: { value: protocol } });
    fireEvent.change(screen.getByLabelText('API base URL'), { target: { value: endpoint } });
    fireEvent.change(screen.getByLabelText('Additional model IDs'), {
      target: { value: 'vendor/model' },
    });
    fill();
    fireEvent.click(screen.getByRole('checkbox'));
    const submit = screen.getByRole('button', { name: 'Save API account' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Get models' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => fireEvent.submit(submit.closest('form')!));
    expect(api.enrollOpenAIAccount).not.toHaveBeenCalled();
    expect(api.discoverApiModels).not.toHaveBeenCalled();
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('PRIVATE_KEY');
    expect((screen.getByLabelText('API base URL') as HTMLInputElement).value).toBe(endpoint);
    fireEvent.change(screen.getByLabelText('API base URL'), {
      target: { value: 'https://gateway.example/v1' },
    });
    fireEvent.change(screen.getByLabelText('Additional model IDs'), {
      target: { value: 'vendor/model' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    await act(async () => fireEvent.click(submit));
    expect(api.enrollOpenAIAccount).toHaveBeenCalledOnce();
    expect(screen.getByText('Work API is ready for new chats.')).toBeTruthy();
  },
);
it('retains a confirmed saved account when its follow-up status read fails', async () => {
  vi.mocked(api.getOpenAIAccounts)
    .mockResolvedValueOnce({ enabled: true, accounts: [] })
    .mockRejectedValueOnce(Error('Status unavailable'));
  await mount();
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'enmaas' } });
  fill();
  fireEvent.click(screen.getByRole('checkbox'));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save API account' })));
  expect(screen.getByText('Work API is ready for new chats.')).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain('Account status could not be loaded');
  expect(api.enrollOpenAIAccount).toHaveBeenCalledOnce();
});
it('shows a catalog failure and allows explicit model IDs without claiming validation', async () => {
  vi.mocked(api.discoverApiModels).mockRejectedValue(Error('PRIVATE_KEY provider response'));
  await mount();
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'custom' } });
  fireEvent.change(screen.getByLabelText('API base URL'), {
    target: { value: 'https://gateway.example/v1' },
  });
  fill();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Get models' })));
  expect(screen.getByRole('alert').textContent).toContain('Could not read the provider catalog');
  expect(document.body.textContent).not.toContain('PRIVATE_KEY');
  fireEvent.change(screen.getByLabelText('Additional model IDs'), {
    target: { value: 'vendor/model' },
  });
  fireEvent.click(screen.getByRole('checkbox'));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save API account' })));
  expect(api.enrollOpenAIAccount).toHaveBeenCalledWith(
    expect.objectContaining({ models: [{ id: 'vendor/model', label: 'vendor/model' }] }),
  );
});
it('discards catalog responses after the endpoint or key changes', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof api.discoverApiModels>>) => void;
  vi.mocked(api.discoverApiModels).mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await mount();
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'custom' } });
  fireEvent.change(screen.getByLabelText('API base URL'), {
    target: { value: 'https://old.example/v1' },
  });
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Get models' }));
  fireEvent.change(screen.getByLabelText('API base URL'), {
    target: { value: 'https://new.example/v1' },
  });
  await act(async () => resolve({ models: [{ id: 'old/model', label: 'Stale' }], partial: false }));
  expect(screen.queryByLabelText('Available models')).toBeNull();
});
it('discovers generic provider models and enrolls the selected models without OpenAI defaults', async () => {
  vi.mocked(api.discoverApiModels).mockResolvedValue({
    models: [{ id: 'vendor/model', label: 'Hosted model' }],
    partial: false,
  });
  await mount();
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'custom' } });
  fireEvent.change(screen.getByLabelText('API base URL'), {
    target: { value: 'https://gateway.example/v1' },
  });
  fill();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Get models' })));
  expect(api.discoverApiModels).toHaveBeenCalledWith({
    csrf: 'csrf',
    endpoint: 'https://gateway.example/v1',
    apiKey: 'PRIVATE_KEY',
  });
  const select = screen.getByLabelText('Available models') as HTMLSelectElement;
  select.options[0].selected = true;
  fireEvent.change(select);
  fireEvent.click(screen.getByRole('checkbox'));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save API account' })));
  expect(api.enrollOpenAIAccount).toHaveBeenCalledWith(
    expect.objectContaining({
      connection: {
        endpoint: 'https://gateway.example/v1',
        protocol: 'responses',
        qualification: {
          source: 'operator',
          streaming: true,
          toolCalls: true,
          continuation: true,
          cancellation: true,
        },
      },
      models: [{ id: 'vendor/model', label: 'Hosted model' }],
    }),
  );
});
it('discovers EnMaaS Messages models and saves a Claude SDK connection', async () => {
  vi.mocked(api.discoverApiModels).mockResolvedValue({
    models: [{ id: 'hosted/claude-sonnet', label: 'Hosted Sonnet' }],
    partial: false,
  });
  await mount();
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'enmaas' } });
  fireEvent.change(screen.getByLabelText('Model API'), { target: { value: 'messages' } });
  expect((screen.getByLabelText('API base URL') as HTMLInputElement).value).toBe(
    'https://api.enmaas.devshift.net',
  );
  expect((screen.getByLabelText('Additional model IDs') as HTMLTextAreaElement).value).toBe('');
  fill();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Get models' })));
  expect(api.discoverApiModels).toHaveBeenCalledWith(
    expect.objectContaining({ protocol: 'messages', authentication: 'bearer' }),
  );
  const select = screen.getByLabelText('Available models') as HTMLSelectElement;
  select.options[0].selected = true;
  fireEvent.change(select);
  fireEvent.click(screen.getByRole('checkbox'));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save API account' })));
  expect(api.enrollOpenAIAccount).toHaveBeenCalledWith(
    expect.objectContaining({
      connection: expect.objectContaining({ protocol: 'messages', authentication: 'bearer' }),
      models: [{ id: 'hosted/claude-sonnet', label: 'Hosted Sonnet' }],
    }),
  );
});
it('pins the two hosted EnMaaS models even when discovery omits them', async () => {
  vi.mocked(api.discoverApiModels).mockResolvedValue({
    models: [{ id: 'paid-model', label: 'Paid model' }],
    partial: true,
  });
  await mount();
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'enmaas' } });
  fill();
  expect((screen.getByLabelText('API base URL') as HTMLInputElement).value).toBe(
    'https://api.enmaas.devshift.net/v1',
  );
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Get models' })));
  expect(screen.getByText(/partial catalog/i)).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox'));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Save API account' })));
  expect(vi.mocked(api.enrollOpenAIAccount).mock.calls[0][0].models?.map((m) => m.id)).toEqual([
    'rits/zai-org/glm-5-3',
    'rits/deepseek-ai/DeepSeek-V4.1-Flash-1017',
  ]);
});
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
it.each(['network', 'unconfirmed'])(
  'keeps a failed %s attempt in review without automatically resubmitting or leaking diagnostics',
  async (scenario) => {
    vi.mocked(api.enrollOpenAIAccount).mockRejectedValue(
      scenario === 'network'
        ? new Error('Bearer PRIVATE_KEY')
        : new api.OpenAIAccountEnrollmentFailure(false),
    );
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
  },
);
it('shows unavailable enrollment for a stale route', async () => {
  vi.mocked(api.getOpenAIAccounts).mockResolvedValue({ enabled: false, accounts: [] });
  await mount();
  expect(screen.getByText('Adding AI API accounts is unavailable.')).toBeTruthy();
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
