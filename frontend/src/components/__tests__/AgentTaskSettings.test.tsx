// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useState } from 'react';
import { AgentTaskSettings } from '../AgentTaskSettings';
import { apiFetch } from '../../lib/api-fetch';
import {
  createChatRuntimeSelection,
  type ChatRuntimeSelection,
} from '../../lib/chat-runtime-selection';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  sessionStorage.clear();
});
const account = { accountId: 'work', provider: 'openai', profileRevision: 'r1' } as const;
const inventory = {
  version: 1,
  authority: 'configuration-only',
  defaultLocation: 'openshell',
  capabilityRevision: 'c1',
  accounts: [
    {
      account,
      label: 'Work',
      models: [{ id: 'luna', label: 'Luna fixture', reasoningEfforts: ['low', 'high'] }],
      modelDiscovery: { source: 'configured', stale: false },
    },
  ],
  targets: [
    {
      targetId: 'shell',
      targetRevision: 't1',
      label: 'OpenShell',
      location: 'openshell',
      harness: 'responses',
    },
    {
      targetId: 'mac',
      targetRevision: 't1',
      label: 'Local Mac',
      location: 'local',
      harness: 'responses',
    },
  ],
  routes: ['shell', 'mac'].map((targetId) => ({
    account,
    targetId,
    harness: 'responses',
    modes: ['agent'],
  })),
  locations: [
    { location: 'openshell', status: 'configured' },
    { location: 'local', status: 'configured' },
  ],
  agentProfiles: [],
};
function Settings({
  label,
  seed = createChatRuntimeSelection(),
}: {
  label: string;
  seed?: ChatRuntimeSelection;
}) {
  const [value, update] = useState(seed);
  return (
    <section aria-label={label}>
      <AgentTaskSettings id={label} value={value} onChange={update} profileLabel={label} />
      <output aria-label={`${label} intent`}>{JSON.stringify(value)}</output>
    </section>
  );
}
it('uses ordinary catalog controls with independent settings and derives software from the route', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => inventory } as Response);
  render(
    <MemoryRouter>
      <Settings label="First task" />
      <Settings label="Second task" />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: /^Agent settings, First task/ }));
  await waitFor(() =>
    expect(
      screen.getByRole('combobox', { name: 'Account', exact: true }).querySelectorAll('option'),
    ).toHaveLength(2),
  );
  fireEvent.change(screen.getByRole('combobox', { name: 'Account', exact: true }), {
    target: { value: 'work' },
  });
  fireEvent.change(screen.getByRole('combobox', { name: 'Thinking level', exact: true }), {
    target: { value: 'high' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Local Mac', exact: true }));
  expect(screen.getByText('Runs with Mitzo Responses')).toBeTruthy();
  expect(screen.getByLabelText('First task intent').textContent).toContain('"targetId":"mac"');
  expect(screen.getByLabelText('First task intent').textContent).toContain(
    '"reasoningEffort":"high"',
  );
  expect(screen.getByLabelText('Second task intent').textContent).toContain('"account":null');
  expect(screen.queryByLabelText('Harness')).toBeNull();
});
it('keeps unavailable account, model and target intent without selecting replacements', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => inventory } as Response);
  const seed = {
    ...createChatRuntimeSelection(),
    account: { accountId: 'missing', model: 'retired', reasoningEffort: 'high' },
    accountReference: { ...account, accountId: 'missing' },
    execution: { location: 'local' as const, targetId: 'old-mac' },
  };
  render(
    <MemoryRouter>
      <Settings label="Retained" seed={seed} />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: /^Agent settings/ }));
  await screen.findByRole('option', { name: 'Unavailable account: missing' });
  expect(screen.getByLabelText('Model')).toHaveProperty('value', 'retired');
  expect(screen.getByLabelText('Retained intent').textContent).toContain('old-mac');
});

it('derives a saved task location from its retained target without replacing the target or account', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => inventory } as Response);
  const seed = {
    ...createChatRuntimeSelection(),
    account: { accountId: 'work', model: 'luna', reasoningEffort: 'high' },
    accountReference: account,
    execution: { location: 'openshell' as const, targetId: 'mac' },
  };
  const update = vi.fn();
  render(
    <MemoryRouter>
      <AgentTaskSettings
        id="saved-task"
        value={seed}
        onChange={update}
        profileLabel="Saved task"
        resolveSavedTarget
      />
    </MemoryRouter>,
  );
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        accountReference: account,
        execution: { location: 'local', targetId: 'mac' },
      }),
    ),
  );
});

it('does not erase saved execution intent when unavailable settings are merely reviewed', async () => {
  vi.mocked(apiFetch).mockResolvedValue({
    ok: false,
    status: 503,
    json: async () => ({ error: 'Unavailable' }),
  } as Response);
  const seed = {
    ...createChatRuntimeSelection(),
    account: { accountId: 'work', model: 'retained-model', reasoningEffort: 'high' },
    accountReference: account,
    execution: { location: 'local' as const, targetId: 'old-mac' },
  };
  const execution = {
    account,
    harness: 'responses' as const,
    targetId: 'old-mac',
    model: 'retained-model',
    reasoningEffort: 'high',
    mode: 'agent' as const,
    authorityRefs: ['retained-grant'],
  };
  const update = vi.fn();
  render(
    <MemoryRouter>
      <AgentTaskSettings
        id="unavailable"
        value={seed}
        onChange={update}
        profileLabel="Retained"
        retainedExecution={execution}
      />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: /^Agent settings/ }));
  await screen.findByText('Execution choices are unavailable. Refresh to retry.');
  fireEvent.click(screen.getByRole('button', { name: 'Done', exact: true }));
  expect(update).toHaveBeenLastCalledWith(
    expect.objectContaining({ account: seed.account, execution: seed.execution }),
    execution,
  );
});
