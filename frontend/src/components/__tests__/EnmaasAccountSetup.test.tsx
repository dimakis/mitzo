// @vitest-environment node-compatible-dom
import { act, type ReactNode } from 'react';
import { cleanup, render as renderView, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EnmaasAccountSetup } from '../EnmaasAccountSetup';
import * as api from '../../lib/connections-api';
vi.mock('../../lib/connections-api', async (original) => ({
  ...(await original<typeof api>()),
  discoverApiModels: vi.fn(),
  enrollOpenAIAccount: vi.fn(),
  refreshEnrolledApiModels: vi.fn(),
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.discoverApiModels).mockResolvedValue({
    models: [{ id: 'catalog/model', label: 'Catalog model' }],
    partial: false,
  });
});
afterEach(cleanup);
const render = (children: ReactNode) => renderView(<MemoryRouter>{children}</MemoryRouter>);
it('reconciles a newer confirmed model list after a lost refresh acknowledgement and retains it through a status outage', async () => {
  const model = (id: string) => ({ id, label: id });
  const account = {
    id: 'saved',
    label: 'EnMaaS',
    projectLabel: 'EnMaaS',
    state: 'ready' as const,
    protocol: 'responses' as const,
    models: [model('one')],
  };
  const props = {
    csrf: 'csrf',
    authorized: true,
    enabled: true,
    accountId: account.id,
    accounts: [account],
    onRefresh: vi.fn(),
    onReauthorizationNeeded: vi.fn(),
  };
  const view = render(<EnmaasAccountSetup {...props} />);
  vi.mocked(api.refreshEnrolledApiModels).mockResolvedValueOnce({
    ...account,
    models: [model('one'), model('two')],
  });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh models' })));
  expect(screen.getByText('2 available · 2 shown')).toBeTruthy();
  vi.mocked(api.refreshEnrolledApiModels).mockRejectedValueOnce(Error('acknowledgement lost'));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh models' })));
  expect(screen.getByText('2 available · 2 shown')).toBeTruthy();
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Check account status' })),
  );
  expect(props.onRefresh).toHaveBeenCalledTimes(2);
  const latest = { ...account, models: [model('one'), model('two'), model('three')] };
  view.rerender(
    <MemoryRouter>
      <EnmaasAccountSetup {...props} accounts={[latest]} />
    </MemoryRouter>,
  );
  expect(screen.getByText('3 available · 3 shown')).toBeTruthy();
  view.rerender(
    <MemoryRouter>
      <EnmaasAccountSetup {...props} enabled={false} accounts={[]} />
    </MemoryRouter>,
  );
  expect(screen.getByText('3 available · 3 shown')).toBeTruthy();
});
it('retains a saved account when its follow-up status read becomes unavailable', async () => {
  vi.mocked(api.enrollOpenAIAccount).mockResolvedValue({
    id: 'saved',
    label: 'EnMaaS',
    projectLabel: 'EnMaaS',
    state: 'ready',
    protocol: 'responses',
    models: [{ id: 'catalog/model', label: 'Catalog model' }],
  });
  const props = {
    csrf: 'csrf',
    authorized: true,
    enabled: true,
    accounts: [],
    onRefresh: vi.fn(),
    onReauthorizationNeeded: vi.fn(),
  };
  const view = render(<EnmaasAccountSetup {...props} />);
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'synthetic-key' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Connect EnMaaS' })));
  view.rerender(
    <MemoryRouter>
      <EnmaasAccountSetup {...props} enabled={false} />
    </MemoryRouter>,
  );
  expect(screen.getByText('Account saved')).toBeTruthy();
  expect(screen.getByText('1 available · 1 shown')).toBeTruthy();
  expect(
    (screen.getByRole('button', { name: 'Refresh models' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(screen.getByRole('button', { name: 'Check account status' })).toBeTruthy();
});
it.each(['responses', 'messages'] as const)(
  'connects %s with all discovered and hosted models and correct authentication',
  async (protocol) => {
    vi.mocked(api.enrollOpenAIAccount).mockResolvedValue({
      id: 'saved',
      label: 'EnMaaS · Work',
      projectLabel: 'EnMaaS',
      state: 'ready',
      protocol,
      models: [{ id: 'catalog/model', label: 'Catalog model' }],
    });
    render(
      <EnmaasAccountSetup
        csrf="csrf"
        authorized
        onReauthorizationNeeded={vi.fn()}
        accounts={[]}
        enabled
        onRefresh={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText('Runtime'), { target: { value: protocol } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'synthetic-key' } });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Connect EnMaaS' })));
    expect(api.discoverApiModels).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'synthetic-key',
        ...(protocol === 'messages' ? { protocol, authentication: 'api-key' } : {}),
      }),
    );
    expect(api.enrollOpenAIAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        models: expect.arrayContaining([{ id: 'catalog/model', label: 'Catalog model' }]),
        connection: expect.objectContaining({
          protocol,
          ...(protocol === 'messages' ? { authentication: 'api-key' } : {}),
        }),
      }),
    );
    expect(screen.getByText('Account saved')).toBeTruthy();
    expect(screen.queryByLabelText('API key')).toBeNull();
  },
);
it('offers a deliberate hosted-model fallback after a catalog outage without saving automatically', async () => {
  vi.mocked(api.discoverApiModels).mockRejectedValue(Error('upstream private body'));
  render(
    <EnmaasAccountSetup
      csrf="csrf"
      authorized
      onReauthorizationNeeded={vi.fn()}
      accounts={[]}
      enabled
      onRefresh={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'synthetic-key' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Connect EnMaaS' })));
  expect(api.enrollOpenAIAccount).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Save with hosted models' })).toBeTruthy();
  expect(document.body.textContent).not.toContain('upstream private body');
});
it('refuses a rejected key without offering an unverified save', async () => {
  vi.mocked(api.discoverApiModels).mockRejectedValue(
    new api.ApiModelDiscoveryFailure('credential_rejected'),
  );
  render(
    <EnmaasAccountSetup
      csrf="csrf"
      authorized
      onReauthorizationNeeded={vi.fn()}
      accounts={[]}
      enabled
      onRefresh={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'synthetic-key' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Connect EnMaaS' })));
  expect(api.enrollOpenAIAccount).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Save with hosted models' })).toBeNull();
  expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('');
  expect(screen.getByRole('alert').textContent).toContain('rejected this key');
});
it('retains uncertain save identity and never automatically resubmits', async () => {
  vi.mocked(api.enrollOpenAIAccount).mockRejectedValue(
    new api.OpenAIAccountEnrollmentFailure(false),
  );
  const refresh = vi.fn();
  render(
    <EnmaasAccountSetup
      csrf="csrf"
      authorized
      onReauthorizationNeeded={vi.fn()}
      accounts={[]}
      enabled
      onRefresh={refresh}
    />,
  );
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'synthetic-key' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Connect EnMaaS' })));
  expect(screen.queryByRole('button', { name: 'Connect EnMaaS' })).toBeNull();
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Check account status' })),
  );
  expect(api.enrollOpenAIAccount).toHaveBeenCalledOnce();
  expect(refresh).toHaveBeenCalledTimes(2);
});
it('recovers the original successful save after a lost acknowledgement', async () => {
  vi.mocked(api.enrollOpenAIAccount).mockRejectedValue(
    new api.OpenAIAccountEnrollmentFailure(false),
  );
  const props = {
    csrf: 'csrf',
    authorized: true,
    enabled: true,
    onReauthorizationNeeded: vi.fn(),
    onRefresh: vi.fn(),
    accounts: [] as import('../../types/connections').EnrolledOpenAIAccount[],
  };
  const view = render(<EnmaasAccountSetup {...props} />);
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'synthetic-key' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Connect EnMaaS' })));
  const requestId = vi.mocked(api.enrollOpenAIAccount).mock.calls[0][0].requestId;
  view.rerender(
    <MemoryRouter>
      <EnmaasAccountSetup
        {...props}
        accounts={[
          {
            id: 'saved',
            requestId,
            label: 'EnMaaS',
            projectLabel: 'EnMaaS',
            state: 'ready',
            protocol: 'responses',
            models: [{ id: 'catalog/model', label: 'Catalog model' }],
          },
        ]}
      />
    </MemoryRouter>,
  );
  expect(screen.getByText('Account saved')).toBeTruthy();
  expect(api.enrollOpenAIAccount).toHaveBeenCalledOnce();
});
