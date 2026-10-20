// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ConversationAgents } from '../ConversationAgents';
import { WorkspaceControls } from '../WorkspaceControls';
import { QuickSettingsField } from '../QuickChatSettings';
import { AccountModelPicker } from '../AccountModelPicker';
import { ChatAgentProfilePicker } from '../ChatAgentProfilePicker';
import { apiFetch } from '../../lib/api-fetch';

vi.mock('../../lib/api-fetch', async (original) => ({
  ...(await original<typeof import('../../lib/api-fetch')>()),
  apiFetch: vi.fn(),
}));
const profile = {
  profileId: 'source-agent',
  revision: 3,
  contentHash: 'a'.repeat(64),
  definition: {
    name: 'Source agent',
    role: 'agent',
    instructions: 'Review the source.',
    expectedOutput: 'Brief',
    acceptanceCriteria: ['Cite evidence'],
    modelPolicyRole: 'agent',
  },
};
const accounts = [
  {
    id: 'fresh',
    label: 'Fresh account',
    models: [
      { id: 'luna-fixture', label: 'Luna fixture', reasoningEfforts: ['low', 'high'] },
      { id: 'luna-alternate', label: 'Luna alternate', reasoningEfforts: ['low', 'high'] },
    ],
  },
];
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    if (path === '/api/agent-library') return Response.json({ drafts: [], versions: [profile] });
    if (path === '/api/accounts') return Response.json(accounts);
    throw Error(`Unexpected request: ${path}`);
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it('keeps Add controls in its real dialog portal without routing them into the outer Workspace sheet', async () => {
  const changeOrdinary = vi.fn();
  const view = render(
    <MemoryRouter initialEntries={['/chat/source?prompt=Retain+the+source']}>
      <WorkspaceControls
        status="Ready"
        leading={
          <ConversationAgents
            scope="source"
            agents={[{ id: 'source', name: 'Mitzo', state: 'Current conversation' }]}
            messages={[]}
          />
        }
        settings={
          <>
            <AccountModelPicker
              sessionId={null}
              preferredModel=""
              presentation="settings"
              onChange={changeOrdinary}
              controlled={{
                accounts,
                selection: { accountId: 'fresh', model: 'luna-fixture' },
                onChange: changeOrdinary,
              }}
            />
            <ChatAgentProfilePicker
              sessionId={null}
              search=""
              label="Agent"
              onChange={changeOrdinary}
              controlled={{ versions: [profile], selection: null, onChange: changeOrdinary }}
            />
            <QuickSettingsField page="repository" title="Repository" value="example/source">
              <input aria-label="Ordinary repository draft" defaultValue="Original source" />
            </QuickSettingsField>
          </>
        }
      >
        {null}
      </WorkspaceControls>
    </MemoryRouter>,
  );
  const workspace = screen.getByRole('button', { name: /^Workspace controls/ });
  fireEvent.click(workspace);
  fireEvent.click(screen.getByRole('button', { name: 'Repository, example/source' }));
  const ordinaryDraft = screen.getByRole('textbox', { name: 'Ordinary repository draft' });
  fireEvent.change(ordinaryDraft, { target: { value: 'Keep the ordinary draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Back to chat settings' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close agent settings' }));
  const opener = screen.getByRole('button', { name: 'Agents, Mitzo' });
  fireEvent.click(opener);
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  const dialog = screen.getByRole('dialog', { name: 'Add agent' });
  expect(view.container.contains(dialog)).toBe(false); // Actual HomeDialog React portal.
  const agent = await within(dialog).findByRole('combobox', { name: 'Agent' });
  const option = await within(dialog).findByRole('option', { name: /Source agent/ });
  fireEvent.change(agent, { target: { value: (option as HTMLOptionElement).value } });
  const account = await within(dialog).findByRole('combobox', { name: 'Account' });
  await waitFor(() =>
    expect(within(account).getByRole('option', { name: 'Fresh account' })).toBeTruthy(),
  );
  fireEvent.change(account, { target: { value: 'fresh' } });
  const model = within(dialog).getByRole('combobox', { name: 'Model' });
  fireEvent.change(model, { target: { value: 'luna-alternate' } });
  const thinking = within(dialog).getByRole('combobox', { name: 'Thinking level' });
  fireEvent.change(thinking, { target: { value: 'high' } });
  const purpose = within(dialog).getByRole('textbox', { name: 'Purpose' });
  fireEvent.change(purpose, { target: { value: 'Preserve this joining draft.' } });
  for (const control of [agent, account, model, thinking])
    expect(control.closest('[hidden], [inert], [aria-hidden="true"]')).toBeNull();
  const summaries = view.container.querySelector('.quick-settings-summaries')!;
  for (const page of ['agent', 'account', 'model', 'thinking'])
    expect(summaries.querySelectorAll(`[data-quick-setting="${page}"]`)).toHaveLength(1);
  expect(workspace.getAttribute('aria-expanded')).toBe('false');
  expect(changeOrdinary).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem('mitzo-default-account-model') ?? 'null')).toBeNull();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Back to Agents' }));
  const add = screen.getByRole('button', { name: 'Add agent' });
  expect(document.activeElement).toBe(add);
  fireEvent.click(add);
  await waitFor(() => {
    expect(within(dialog).getByRole('combobox', { name: 'Agent' })).toHaveProperty(
      'value',
      (option as HTMLOptionElement).value,
    );
    expect(within(dialog).getByRole('combobox', { name: 'Account' })).toHaveProperty(
      'value',
      'fresh',
    );
    expect(within(dialog).getByRole('combobox', { name: 'Model' })).toHaveProperty(
      'value',
      'luna-alternate',
    );
    expect(within(dialog).getByRole('combobox', { name: 'Thinking level' })).toHaveProperty(
      'value',
      'high',
    );
    expect(within(dialog).getByRole('textbox', { name: 'Purpose' })).toHaveProperty(
      'value',
      'Preserve this joining draft.',
    );
  });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close Agents' }));
  expect(document.activeElement).toBe(opener);
  fireEvent.click(opener);
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }));
  const reopened = screen.getByRole('dialog', { name: 'Add agent' });
  await waitFor(() =>
    expect(within(reopened).getByRole('combobox', { name: 'Agent' })).toHaveProperty(
      'value',
      (option as HTMLOptionElement).value,
    ),
  );
  expect(within(reopened).getByRole('combobox', { name: 'Model' })).toHaveProperty(
    'value',
    'luna-alternate',
  );
  expect(within(reopened).getByRole('combobox', { name: 'Thinking level' })).toHaveProperty(
    'value',
    'high',
  );
  expect(within(reopened).getByRole('textbox', { name: 'Purpose' })).toHaveProperty(
    'value',
    'Preserve this joining draft.',
  );
  fireEvent.click(within(reopened).getByRole('button', { name: 'Close Agents' }));
  fireEvent.click(workspace);
  fireEvent.click(screen.getByRole('button', { name: 'Repository, example/source' }));
  expect(screen.getByRole('textbox', { name: 'Ordinary repository draft' })).toBe(ordinaryDraft);
  expect(ordinaryDraft).toHaveProperty('value', 'Keep the ordinary draft');
  expect(changeOrdinary).not.toHaveBeenCalled();
});
