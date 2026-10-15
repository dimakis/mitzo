// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { AgentSettingsFields } from '../AgentSettingsPicker';
import { WorkspaceControls } from '../WorkspaceControls';

afterEach(cleanup);
it('keeps back, settings, Access and new chat together without mounting another settings picker', () => {
  render(
    <WorkspaceControls
      status="Ready"
      summary={{ profile: 'Work', model: 'Luna' }}
      leading={<button>Back to chats</button>}
      trailing={<button>New chat</button>}
      actions={<button>Access</button>}
      settings={<p>One settings field set</p>}
    >
      {null}
    </WorkspaceControls>,
  );
  expect(
    screen.getByRole('button', { name: 'Back to chats' }).closest('.workspace-controls-heading'),
  ).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'New chat' }).closest('.workspace-controls-heading'),
  ).toBeTruthy();
  expect(screen.getAllByText('One settings field set')).toHaveLength(1);
});
it('prioritizes account/model/thinking, keeps repository with the agent, and reveals runtime last', () => {
  render(
    <AgentSettingsFields
      accountModel={
        <>
          <label>
            Account
            <input />
          </label>
          <label>
            Model
            <input />
          </label>
          <label>
            Thinking
            <input />
          </label>
        </>
      }
      agent={
        <label>
          Agent
          <input />
        </label>
      }
      repository={<button>Choose repository</button>}
      execution={<button>OpenShell runtime</button>}
    />,
  );
  const labels = screen.getAllByRole('textbox').map((input) => input.parentElement?.textContent);
  expect(labels).toEqual(['Account', 'Model', 'Thinking', 'Agent']);
  expect(
    screen.getByRole('button', { name: 'Choose repository' }).closest('.chat-settings-group')
      ?.textContent,
  ).toContain('Agent');
  const advanced = screen.getByText('Advanced').closest('details')!;
  expect(advanced.open).toBe(false);
  fireEvent.click(screen.getByText('Advanced'));
  expect(advanced.open).toBe(true);
  expect(advanced.contains(screen.getByRole('button', { name: 'OpenShell runtime' }))).toBe(true);
});
