// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatExecutionPicker } from '../ChatExecutionPicker';
import { multiRuntimeInventoryFixture } from '../../test-utils/multi-runtime-inventory-fixture';
import { createChatRuntimeSelection } from '../../lib/chat-runtime-selection';
afterEach(cleanup);
it('settings uses two named environment cards and retains reasons without redundant review controls', () => {
  const data = multiRuntimeInventoryFixture(),
    update = vi.fn();
  const runtime = {
    intent: {
      ...createChatRuntimeSelection(),
      account: { accountId: 'api', model: 'local-model', reasoningEffort: null },
      accountReference: data.accounts[1].account,
      execution: { location: 'local', targetId: 'responses' },
    },
    inventory: data,
    visible: true,
    bound: false,
    selectedLocal: true,
    reason: 'Review the selected account before sending.',
    update,
    review: vi.fn(),
    refresh: vi.fn(),
  } as never;
  render(
    <MemoryRouter>
      <ChatExecutionPicker runtime={runtime} presentation="settings" />
    </MemoryRouter>,
  );
  expect(screen.getByRole('group', { name: 'Run on' })).toBeTruthy();
  expect(screen.queryByRole('combobox', { name: 'Run on' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Local Mac' }).getAttribute('aria-pressed')).toBe(
    'true',
  );
  expect(screen.getByRole('button', { name: 'OpenShell' }).getAttribute('aria-pressed')).toBe(
    'false',
  );
  expect(screen.getByText('Run tools in an isolated sandbox.')).toBeTruthy();
  expect(screen.getByText('Run tools on this Mac.')).toBeTruthy();
  expect(screen.getByText('Runs with Mitzo Responses')).toBeTruthy();
  expect(screen.getByRole('status').textContent).toBe(
    'Review the selected account before sending.',
  );
  expect(screen.queryByRole('button', { name: /Refresh execution|Use these/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'OpenShell' }));
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({
      execution: { location: 'openshell', targetId: null },
      capabilityRevision: null,
    }),
  );
});

it('settings keeps bound environment immutable and retains the new-session escape path', () => {
  const update = vi.fn();
  const runtime = {
    intent: {
      ...createChatRuntimeSelection(),
      account: { accountId: 'api', model: 'local-model' },
      agentProfile: { profileId: 'bob', revision: 1 },
      execution: { location: 'local', targetId: 'responses' },
    },
    inventory: multiRuntimeInventoryFixture(),
    visible: true,
    bound: true,
    continuation: true,
    binding: { execution: { location: 'local' }, harness: { implementation: 'responses' } },
    reason: 'Same account and checkout.',
    update,
    review: vi.fn(),
    refresh: vi.fn(),
  } as never;
  render(
    <MemoryRouter>
      <ChatExecutionPicker runtime={runtime} presentation="settings" />
    </MemoryRouter>,
  );
  expect(screen.getByText('Fixed for this conversation')).toBeTruthy();
  for (const name of ['Local Mac', 'OpenShell']) {
    const button = screen.getByRole('button', { name });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(button);
  }
  expect(update).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'New session on OpenShell' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Use these conversation choices' })).toBeNull();
});

it('settings leaves unknown binding recovery intact', () => {
  const refresh = vi.fn();
  render(
    <MemoryRouter>
      <ChatExecutionPicker
        presentation="settings"
        runtime={
          {
            visible: true,
            intent: createChatRuntimeSelection(),
            metadataUnavailable: true,
            reason: 'Conversation metadata unavailable.',
            refresh,
          } as never
        }
      />
    </MemoryRouter>,
  );
  expect(screen.queryByRole('group', { name: 'Run on' })).toBeNull();
  expect(screen.getByRole('alert').textContent).toBe('Conversation metadata unavailable.');
  fireEvent.click(screen.getByRole('button', { name: 'Retry conversation settings' }));
  expect(refresh).toHaveBeenCalledOnce();
});

it.each([{ disabled: true }, { executionLocked: true }])(
  'settings retains guarded environment controls for %j',
  (guard) => {
    const update = vi.fn();
    render(
      <MemoryRouter>
        <ChatExecutionPicker
          presentation="settings"
          {...guard}
          runtime={
            {
              visible: true,
              intent: createChatRuntimeSelection(),
              inventory: multiRuntimeInventoryFixture(),
              update,
            } as never
          }
        />
      </MemoryRouter>,
    );
    for (const name of ['OpenShell', 'Local Mac']) {
      const button = screen.getByRole('button', { name });
      expect(button.hasAttribute('disabled')).toBe(true);
      fireEvent.click(button);
    }
    expect(update).not.toHaveBeenCalled();
  },
);
it('renders precisely two environments for three Local adapters and derives software from exact chosen tuple', () => {
  const data = multiRuntimeInventoryFixture(),
    update = vi.fn();
  const runtime = {
    intent: {
      ...createChatRuntimeSelection(),
      account: { accountId: 'api', model: 'local-model', reasoningEffort: null },
      accountReference: data.accounts[1].account,
      execution: { location: 'local', targetId: 'responses' },
    },
    inventory: data,
    visible: true,
    bound: false,
    selectedLocal: true,
    update,
    review: vi.fn(),
    refresh: vi.fn(),
  } as never;
  render(
    <MemoryRouter>
      <ChatExecutionPicker runtime={runtime} />
    </MemoryRouter>,
  );
  expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
    'OpenShell',
    'Local Mac',
  ]);
  expect(screen.getByText('Runs with Mitzo Responses')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Run on'), { target: { value: 'openshell' } });
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({ execution: { location: 'openshell', targetId: null } }),
  );
  expect(screen.queryByText(/signed-in ChatGPT/)).toBeNull();
});

it('settings retries a failed execution inventory without adding routine review controls', () => {
  const refresh = vi.fn();
  render(
    <MemoryRouter>
      <ChatExecutionPicker
        presentation="settings"
        runtime={
          {
            visible: true,
            intent: createChatRuntimeSelection(),
            error: 'Execution choices unavailable.',
            refresh,
          } as never
        }
      />
    </MemoryRouter>,
  );
  expect(screen.getByRole('alert').textContent).toBe('Execution choices unavailable.');
  fireEvent.click(screen.getByRole('button', { name: 'Retry execution choices' }));
  expect(refresh).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: /Use these/ })).toBeNull();
});
