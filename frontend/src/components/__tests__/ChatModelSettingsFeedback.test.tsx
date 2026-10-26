// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QuickSettingsChoices } from '../QuickChatSettings';
afterEach(cleanup);
it('explains a lock and allows retry without enabling settings', () => {
  const retry = vi.fn();
  const change = vi.fn();
  render(
    <QuickSettingsChoices
      title="Thinking"
      value="low"
      choices={[
        { id: 'low', label: 'Low' },
        { id: 'high', label: 'High' },
      ]}
      disabled
      disabledReason="Conversation settings could not be loaded. Retry to continue."
      onRetry={retry}
      onChange={change}
    />,
  );
  expect(screen.getByRole('status')).toHaveTextContent('could not be loaded');
  expect(screen.getByRole('button', { name: 'High' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry settings' }));
  expect(retry).toHaveBeenCalledOnce();
  expect(change).not.toHaveBeenCalled();
});
it('shows next-message semantics without disabling the choices', () => {
  render(
    <QuickSettingsChoices
      title="Model"
      value="luna"
      choices={[{ id: 'luna', label: 'Luna' }]}
      notice="Changes apply to your next message. The current response keeps its settings."
      onChange={vi.fn()}
    />,
  );
  expect(screen.getByRole('status')).toHaveTextContent('next message');
  expect(screen.getByRole('button', { name: 'Luna' })).toBeEnabled();
});

it('keeps recovery available when metadata failed before choices could load', async () => {
  const { AccountModelPicker } = await import('../AccountModelPicker');
  const retry = vi.fn();
  const fetcher = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('', { status: 503 }));
  try {
    render(
      <AccountModelPicker
        sessionId="unavailable-chat"
        preferredModel="luna"
        onChange={vi.fn()}
        disabled
        disabledReason="Conversation settings could not be loaded. Retry to continue."
        onRetry={retry}
      />,
    );
    const action = await screen.findByRole('button', { name: 'Retry settings' });
    expect(action).toBeEnabled();
    fireEvent.click(action);
    expect(retry).toHaveBeenCalledOnce();
  } finally {
    fetcher.mockRestore();
  }
});
