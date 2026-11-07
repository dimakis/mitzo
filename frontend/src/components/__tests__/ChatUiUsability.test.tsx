// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatExecutionPicker } from '../ChatExecutionPicker';
import { SessionResourcesDialog } from '../SessionResourcesDialog';
import { multiRuntimeInventoryFixture } from '../../test-utils/multi-runtime-inventory-fixture';
import { createChatRuntimeSelection } from '../../lib/chat-runtime-selection';
vi.mock('../ContextPanel', () => ({ ContextPanel: () => <p>Optional context blocks</p> }));
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);
function host(targets = 1, targetId: string | null = 'mac') {
  const data = multiRuntimeInventoryFixture();
  data.routes[0].location = 'local';
  if (!targets) data.targets = [];
  if (targets > 1) {
    data.targets.push({ ...data.targets[0], targetId: 'second', label: 'Second Mac' });
    data.routes.push({ ...data.routes[0], targetId: 'second' });
  }
  return render(
    <MemoryRouter>
      <ChatExecutionPicker
        presentation="settings"
        runtime={
          {
            visible: true,
            intent: {
              ...createChatRuntimeSelection(),
              account: { accountId: 'personal', model: 'luna-fixture' },
              accountReference: data.accounts[0].account,
              execution: { location: 'local', targetId },
            },
            inventory: data,
            update: vi.fn(),
          } as never
        }
      />
    </MemoryRouter>,
  );
}
it('shows a single execution host as text, retaining a real choice for multiple hosts', () => {
  const view = host();
  expect(screen.queryByRole('combobox', { name: 'Execution host' })).toBeNull();
  expect(screen.getByText('This Mac')).toBeTruthy();
  view.unmount();
  host(2);
  expect(
    screen.getByRole('combobox', { name: 'Execution host' }).querySelectorAll('option'),
  ).toHaveLength(2);
});
it('shows unavailable and loading hosts without empty menus or silently replacing a saved host', () => {
  host(0, 'saved-mac');
  expect(screen.queryByRole('combobox', { name: 'Execution host' })).toBeNull();
  expect(screen.getByText(/Unavailable host: saved-mac/)).toBeTruthy();
});
const resources = {
  messages: [],
  selectedContextBlocks: [],
  draftImages: [],
  onToggleContextBlock: vi.fn(),
  onAddImages: vi.fn(),
  onRemoveImage: vi.fn(),
};
it('puts measured token usage and budget first in Context, without inventing capacity', () => {
  const view = render(
    <SessionResourcesDialog
      {...resources}
      tokenState={
        {
          agentContext: 80000,
          sessionTotal: 900000,
          sessionTotalStatus: 'observed',
          tokenLimits: { source: 'runtime', contextWindow: 200000, model: 'fixture' },
        } as never
      }
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open session tray' }));
  fireEvent.click(screen.getByRole('tab', { name: 'Context' }));
  expect(screen.getByRole('meter', { name: 'Context used' }).getAttribute('aria-valuenow')).toBe(
    '40',
  );
  expect(screen.getByText(/80k.*200k/i)).toBeTruthy();
  expect(screen.getByText(/120k.*remaining/i)).toBeTruthy();
  view.rerender(
    <SessionResourcesDialog
      {...resources}
      tokenState={
        {
          agentContext: 80000,
          tokenLimits: { source: 'runtime', contextWindow: 200000, stale: true },
        } as never
      }
    />,
  );
  expect(screen.queryByRole('meter')).toBeNull();
  expect(screen.getByText(/limit not reported/)).toBeTruthy();
});
it('explains References and keeps tool-only URLs out of the conversation links by default', () => {
  render(
    <SessionResourcesDialog
      {...resources}
      messages={
        [
          {
            messageId: 'm',
            role: 'assistant',
            blocks: [
              { blockId: 'text', blockType: 'text', content: 'See https://example.com/report' },
              {
                blockId: 'tool',
                blockType: 'tool_use',
                toolName: 'Read',
                content: '',
                toolResult: 'https://api.example.com/internal https://avatars.example.com/image',
              },
            ],
          },
        ] as never
      }
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open session tray' }));
  fireEvent.click(screen.getByRole('tab', { name: 'References' }));
  expect(screen.getByText(/Links shared in this conversation/)).toBeTruthy();
  expect(screen.getAllByTestId('reference-domain')).toHaveLength(1);
  fireEvent.click(screen.getByRole('checkbox', { name: /Include links from tool output/ }));
  expect(screen.getAllByTestId('reference-domain')).toHaveLength(3);
});
