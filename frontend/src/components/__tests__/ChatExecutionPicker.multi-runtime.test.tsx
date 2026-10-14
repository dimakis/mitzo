// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatExecutionPicker } from '../ChatExecutionPicker';
import { multiRuntimeInventoryFixture } from '../../test-utils/multi-runtime-inventory-fixture';
import { createChatRuntimeSelection } from '../../lib/chat-runtime-selection';
afterEach(cleanup);
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
