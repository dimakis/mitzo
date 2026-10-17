// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { localInventoryFixture } from '../../test-utils/local-inventory-fixture';
import { createChatRuntimeSelection } from '../../lib/chat-runtime-selection';
import type { TelosRoleSetupOptions } from '../../hooks/useTelosRoleSetup';
import { TelosRoleSetup } from '../TelosRoleSetup';
const state = vi.hoisted(() => ({
  options: null as TelosRoleSetupOptions | null,
  boundConversationId: null as string | null,
  review: vi.fn(async () => {}),
  confirm: vi.fn(async () => {}),
  retry: vi.fn(async () => {}),
}));
vi.mock('../../hooks/useTelosRoleSetup', () => ({
  useTelosRoleSetup: (options: TelosRoleSetupOptions) => {
    state.options = options;
    return {
      context: null,
      boundConversationId: state.boundConversationId,
      pending: null,
      error: null,
      uncertain: false,
      locked: false,
      canConfirm: !!options.settings,
      review: state.review,
      confirm: state.confirm,
      retry: state.retry,
    };
  },
}));
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn(), getApiBaseUrl: () => '' }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.options = null;
  state.boundConversationId = null;
});
it('derives exact ordinary settings and offers one silent binding action without a model send', async () => {
  const inventory = localInventoryFixture();
  const intent = {
    ...createChatRuntimeSelection(),
    execution: { location: 'local' as const, targetId: 'mac' },
    capabilityRevision: inventory.capabilityRevision,
    account: { accountId: 'personal', model: 'luna-fixture', reasoningEffort: 'low' },
    agentProfile: { profileId: 'agent', revision: 1 },
  };
  render(
    <MemoryRouter>
      <TelosRoleSetup
        intent={{ itemId: 'item', role: 'lead', mode: 'assign' }}
        runtime={{ intent, inventory, reason: undefined } as never}
        repositoryWorkspaceId="11111111-1111-4111-8111-111111111111"
        mode="agent"
        draftId="draft"
        onBound={vi.fn()}
        onLocked={vi.fn()}
        beforeConfirm={() => true}
      />
    </MemoryRouter>,
  );
  await waitFor(() => expect(state.review).toHaveBeenCalledOnce());
  expect(state.options?.settings).toMatchObject({
    binding: {
      version: 2,
      account: inventory.accounts[0].account,
      harness: { implementation: 'codex' },
      execution: { location: 'local', targetId: 'mac', targetRevision: 'target-r1' },
    },
    selection: { model: 'luna-fixture', thinking: 'low', agent: intent.agentProfile },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Assign lead & open chat' }));
  expect(state.confirm).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: 'Review work context' })).toBeNull();
  expect(
    screen.getByText(
      'Collaborate on the plan, maintain the brief, delegate each slice to its own worker chat, coordinate dependencies and review returned evidence.',
    ),
  ).toBeTruthy();
});

it('reopens a confirmed retained role chat without a fresh setup or model send', async () => {
  state.boundConversationId = 'retained-role-chat';
  const onBound = vi.fn();
  render(
    <MemoryRouter>
      <TelosRoleSetup
        intent={{ itemId: 'item', role: 'lead', mode: 'assign' }}
        runtime={
          { intent: createChatRuntimeSelection(), inventory: null, reason: 'Unavailable' } as never
        }
        mode="agent"
        draftId="draft"
        onBound={onBound}
        onLocked={vi.fn()}
        beforeConfirm={() => true}
      />
    </MemoryRouter>,
  );
  await waitFor(() => expect(onBound).toHaveBeenCalledWith('retained-role-chat'));
  expect(state.confirm).not.toHaveBeenCalled();
  expect(state.review).not.toHaveBeenCalled();
  expect(state.retry).not.toHaveBeenCalled();
});
