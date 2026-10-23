// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useState } from 'react';
import { AgentTaskSettings } from '../AgentTaskSettings';
import { AgentTaskEditor } from '../AgentTaskEditor';
import {
  type AgentTaskWorkingCopy,
  createAgentTaskWorkingCopy,
} from '../../lib/agent-task-working-copy';
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
const nativeTaskInventory = {
  ...inventory,
  targets: inventory.targets.map((target) => ({ ...target, harness: 'codex' })),
  routes: inventory.routes.map((route) => ({ ...route, harness: 'codex' })),
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
  vi.mocked(apiFetch).mockResolvedValue({
    ok: true,
    json: async () => nativeTaskInventory,
  } as Response);
  render(
    <MemoryRouter>
      <Settings label="First task" />
      <Settings label="Second task" />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: /^Agent settings, First task/ }));
  await waitFor(() =>
    expect(
      screen.getByRole('combobox', { name: 'Account' }).querySelectorAll('option'),
    ).toHaveLength(2),
  );
  fireEvent.change(screen.getByRole('combobox', { name: 'Account' }), {
    target: { value: 'work' },
  });
  fireEvent.change(screen.getByRole('combobox', { name: 'Thinking level' }), {
    target: { value: 'high' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Local Mac' }));
  expect(screen.getByText('Runs with Codex')).toBeTruthy();
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
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(update).toHaveBeenLastCalledWith(
    expect.objectContaining({ account: seed.account, execution: seed.execution }),
    execution,
  );
});

it.each([
  { revision: 0, dirty: true, collidingTargets: false },
  { revision: 0, dirty: true, collidingTargets: true },
  { revision: 1, dirty: false, collidingTargets: false },
  { revision: 1, dirty: false, collidingTargets: true },
])(
  'restores the retained route at revision $revision without changing input when target IDs collide: $collidingTargets',
  async ({ revision, dirty, collidingTargets }) => {
    const subscription = {
      accountId: 'subscription',
      provider: 'openai-codex',
      profileRevision: 'r2',
    };
    const catalog = collidingTargets
      ? {
          ...inventory,
          accounts: [
            ...inventory.accounts,
            { ...inventory.accounts[0], account: subscription, label: 'Subscription' },
          ],
          targets: [
            ...inventory.targets,
            {
              targetId: 'mac',
              targetRevision: 't2',
              label: 'OpenShell Codex',
              location: 'openshell',
              harness: 'codex',
            },
          ],
          routes: [
            ...inventory.routes,
            { account: subscription, targetId: 'mac', harness: 'codex', modes: ['agent'] },
          ],
        }
      : inventory;
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => catalog } as Response);
    const seed = {
      ...createAgentTaskWorkingCopy({
        profileId: 'bob',
        revision: 3,
        contentHash: 'a'.repeat(64),
        definition: {
          name: 'Bob',
          role: 'agent',
          instructions: 'Review',
          expectedOutput: 'Brief',
          acceptanceCriteria: ['Evidence'],
          modelPolicyRole: 'agent',
        },
      }),
      expectedRevision: revision,
      dirty,
      execution: {
        account,
        harness: 'responses' as const,
        targetId: 'mac',
        model: 'luna',
        reasoningEffort: 'high',
        mode: 'agent' as const,
        authorityRefs: [],
      },
    };
    seed.runtime = {
      ...seed.runtime,
      account: { accountId: 'work', model: 'luna', reasoningEffort: 'high' },
      accountReference: account,
      execution: { location: 'openshell', targetId: 'mac' },
    };
    function Editor() {
      const [copy, update] = useState<AgentTaskWorkingCopy>(seed);
      return (
        <>
          <AgentTaskEditor copy={copy} update={update} versions={[]} busy={false} save={() => {}} />
          <output aria-label="Copy">{JSON.stringify(copy)}</output>
        </>
      );
    }
    render(
      <MemoryRouter>
        <Editor />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(
        JSON.parse(screen.getByLabelText('Copy').textContent!).runtime.execution.location,
      ).toBe('local'),
    );
    expect(JSON.parse(screen.getByLabelText('Copy').textContent!)).toMatchObject({
      expectedRevision: revision,
      dirty,
      idempotencyKey: seed.idempotencyKey,
    });
    fireEvent.click(screen.getByRole('button', { name: /^Agent settings/ }));
    expect(screen.getByRole('option', { name: 'Luna fixture' })).toBeTruthy();
    expect(screen.getByText('Runs with Mitzo Responses')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(JSON.parse(screen.getByLabelText('Copy').textContent!)).toMatchObject({
      expectedRevision: revision,
      dirty,
      idempotencyKey: seed.idempotencyKey,
      execution: seed.execution,
      runtime: { accountReference: account, execution: { location: 'local', targetId: 'mac' } },
    });
  },
);

it.each([
  { revision: 1, dirty: false },
  { revision: 0, dirty: true },
])(
  'automatic target hydration preserves revision $revision, dirty state and retry identity',
  async ({ revision, dirty }) => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => nativeTaskInventory,
    } as Response);
    const seed = {
      ...createAgentTaskWorkingCopy({
        profileId: 'bob',
        revision: 3,
        contentHash: 'a'.repeat(64),
        definition: {
          name: 'Bob',
          role: 'agent',
          instructions: 'Review',
          expectedOutput: 'Brief',
          acceptanceCriteria: ['Evidence'],
          modelPolicyRole: 'agent',
        },
      }),
      expectedRevision: revision,
      dirty,
    };
    function Editor() {
      const [copy, update] = useState<AgentTaskWorkingCopy>(seed);
      return (
        <>
          <AgentTaskEditor copy={copy} update={update} versions={[]} busy={false} save={() => {}} />
          <output aria-label="Copy">{JSON.stringify(copy)}</output>
        </>
      );
    }
    render(
      <MemoryRouter>
        <Editor />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(
        JSON.parse(screen.getByLabelText('Copy').textContent!).runtime.execution.targetId,
      ).toBe('shell'),
    );
    expect(JSON.parse(screen.getByLabelText('Copy').textContent!)).toMatchObject({
      expectedRevision: revision,
      dirty,
      idempotencyKey: seed.idempotencyKey,
      execution: null,
    });
  },
);
