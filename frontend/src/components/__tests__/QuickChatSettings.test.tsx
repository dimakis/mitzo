// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { WorkspaceControls } from '../WorkspaceControls';
import { QuickSettingsField } from '../QuickChatSettings';
import { AccountModelPicker } from '../AccountModelPicker';
import { ModelBrandMark, RuntimeBrandMark } from '../SettingsBrandMark';

afterEach(cleanup);

function Example() {
  const [account, setAccount] = useState('Work');
  return (
    <WorkspaceControls
      status="Ready"
      settings={
        <>
          <QuickSettingsField page="account" title="Account" value={account}>
            <input
              aria-label="Choose account"
              value={account}
              onChange={(event) => setAccount(event.target.value)}
            />
          </QuickSettingsField>
          <QuickSettingsField
            page="execution"
            title="Run on"
            value="OpenShell"
            mark={<RuntimeBrandMark location="openshell" />}
          >
            <button>OpenShell runtime</button>
          </QuickSettingsField>
        </>
      }
    >
      <button>Voice settings</button>
    </WorkspaceControls>
  );
}

it('opens one field at a time, keeps editor state mounted, and returns focus to its row', () => {
  render(<Example />);
  fireEvent.click(screen.getByRole('button', { name: /^Workspace controls/ }));
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Run on, OpenShell' }).querySelector('.openshell-brand'),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Account, Work' }));
  const input = screen.getByRole('textbox', { name: 'Choose account' });
  expect(screen.queryByRole('button', { name: 'Run on, OpenShell' })).toBeNull();
  fireEvent.change(input, { target: { value: 'Personal' } });
  fireEvent.click(screen.getByRole('button', { name: 'Back to chat settings' }));
  const row = screen.getByRole('button', { name: 'Account, Personal' });
  expect(document.activeElement).toBe(row);
  fireEvent.click(row);
  expect(screen.getByRole('textbox', { name: 'Choose account' })).toBe(input);
  expect((input as HTMLInputElement).value).toBe('Personal');
});

it('uses Escape to leave an editor before closing the sheet, and preserves secondary options', () => {
  render(<Example />);
  const trigger = screen.getByRole('button', { name: /^Workspace controls/ });
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('button', { name: 'More options, Permissions, web & voice' }));
  expect(screen.getByRole('button', { name: 'Voice settings' })).toBeTruthy();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(screen.getByRole('button', { name: 'Account, Work' })).toBeTruthy();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger);
});

it('retains bound account/model guards while exposing supported thinking changes', () => {
  const change = vi.fn();
  render(
    <WorkspaceControls
      status="Ready"
      settings={
        <AccountModelPicker
          sessionId={null}
          preferredModel="gpt-fixture"
          presentation="settings"
          onChange={change}
          lockAccountModel
          controlled={{
            accounts: [
              {
                id: 'work',
                label: 'Work',
                models: [
                  { id: 'gpt-fixture', label: 'GPT fixture', reasoningEfforts: ['medium', 'high'] },
                ],
              },
            ],
            selection: { accountId: 'work', model: 'gpt-fixture', reasoningEffort: 'medium' },
            onChange: change,
          }}
        />
      }
    >
      {null}
    </WorkspaceControls>,
  );
  fireEvent.click(screen.getByRole('button', { name: /^Workspace controls/ }));
  expect(screen.queryByRole('combobox')).toBeNull();
  const modelRow = screen.getByRole('button', { name: 'Model, GPT fixture' });
  expect(modelRow.querySelector('.model-brand--openai')).toBeTruthy();
  fireEvent.click(modelRow);
  const editor = screen.getByRole('region', { name: 'Model options' });
  const model = within(editor).getByRole('button', { name: 'GPT fixture' });
  expect((model as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(model);
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Back to chat settings' }));
  fireEvent.click(screen.getByRole('button', { name: 'Thinking, medium' }));
  fireEvent.click(screen.getByRole('button', { name: 'high' }));
  expect(change).toHaveBeenCalledWith({
    accountId: 'work',
    model: 'gpt-fixture',
    reasoningEffort: 'high',
  });
});

it('uses model identity for brand marks and leaves unknown providers unbranded', () => {
  const view = render(
    <>
      <ModelBrandMark model="claude-sonnet-fixture" />
      <ModelBrandMark model="gemini-fixture" />
      <ModelBrandMark model="gpt-fixture" />
    </>,
  );
  expect(view.container.querySelectorAll('.model-brand')).toHaveLength(2);
  expect(view.container.querySelector('.model-brand--claude')).toBeTruthy();
  expect(view.container.querySelector('.model-brand--openai')).toBeTruthy();
});

it('saves and clears controlled new-chat defaults without changing the reviewed selection', () => {
  localStorage.clear();
  const change = vi.fn();
  render(
    <WorkspaceControls
      status="Ready"
      settings={
        <AccountModelPicker
          sessionId={null}
          preferredModel="gpt-fixture"
          presentation="settings"
          onChange={change}
          controlled={{
            accounts: [
              { id: 'work', label: 'Work', models: [{ id: 'gpt-fixture', label: 'GPT fixture' }] },
            ],
            selection: { accountId: 'work', model: 'gpt-fixture' },
            onChange: change,
          }}
        />
      }
    >
      {null}
    </WorkspaceControls>,
  );
  fireEvent.click(screen.getByRole('button', { name: /^Workspace controls/ }));
  fireEvent.click(screen.getByRole('button', { name: 'New-chat defaults, Not set' }));
  fireEvent.click(screen.getByRole('button', { name: 'Make default for new chats' }));
  expect(JSON.parse(localStorage.getItem('mitzo-default-account-model')!)).toEqual({
    accountId: 'work',
    model: 'gpt-fixture',
  });
  fireEvent.click(screen.getByRole('button', { name: 'Clear new-chat default' }));
  expect(localStorage.getItem('mitzo-default-account-model')).toBeNull();
  expect(change).not.toHaveBeenCalled();
});
