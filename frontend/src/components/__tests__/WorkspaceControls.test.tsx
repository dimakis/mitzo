// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WorkspaceControls } from '../WorkspaceControls';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});
const props = {
  status: 'Ready',
  summary: { profile: 'Personal', model: 'Luna', thinking: 'High' },
};

it('starts closed even with a previous open preference or review attention', () => {
  localStorage.setItem('mitzo-workspace-controls-expanded', '1');
  render(
    <WorkspaceControls {...props} attention>
      <button>Change model</button>
    </WorkspaceControls>,
  );
  const trigger = screen.getByRole('button', { name: /^Workspace controls/ });
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('button', { name: 'Change model' })).toBeNull();
});

it('closes on any outside pointer without stealing focus, and retains controls and drafts', () => {
  render(
    <>
      <WorkspaceControls {...props}>
        <input aria-label="Choice" defaultValue="Retain" />
      </WorkspaceControls>
      <textarea aria-label="Message" />
      <button>Access</button>
    </>,
  );
  const trigger = screen.getByRole('button', { name: /^Workspace controls/ });
  fireEvent.click(trigger);
  const field = screen.getByRole('textbox', { name: 'Choice' });
  fireEvent.pointerDown(field);
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  const message = screen.getByRole('textbox', { name: 'Message' });
  message.focus();
  fireEvent.pointerDown(message);
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(message);
  expect(field.isConnected).toBe(true);
  fireEvent.click(trigger);
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Access' }));
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
});

it('closes on Escape and Done and returns keyboard focus to the summary', () => {
  const review = vi.fn();
  render(
    <WorkspaceControls {...props} onDone={review}>
      <input aria-label="Choice" />
    </WorkspaceControls>,
  );
  const trigger = screen.getByRole('button', { name: /^Workspace controls/ });
  fireEvent.click(trigger);
  screen.getByRole('textbox').focus();
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger);
  expect(review).not.toHaveBeenCalled();
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(review).toHaveBeenCalledOnce();
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
});

it('closes when changing conversations without resetting mounted fields', () => {
  const view = render(
    <WorkspaceControls {...props} scopeKey="first">
      <input aria-label="Choice" />
    </WorkspaceControls>,
  );
  const trigger = screen.getByRole('button', { name: /^Workspace controls/ });
  fireEvent.click(trigger);
  view.rerender(
    <WorkspaceControls {...props} scopeKey="second">
      <input aria-label="Choice" />
    </WorkspaceControls>,
  );
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
});

it('groups secondary controls behind More settings in the single top panel', () => {
  const view = render(
    <WorkspaceControls
      {...props}
      settings={
        <label>
          Agent
          <select aria-label="Agent">
            <option>Mitzo</option>
          </select>
        </label>
      }
    >
      <button>Collaborate</button>
    </WorkspaceControls>,
  );
  const trigger = screen.getByRole('button', { name: /^Workspace controls/ });
  fireEvent.click(trigger);
  expect(screen.getByRole('combobox', { name: 'Agent' })).toBeTruthy();
  const options = view.container.querySelector('details')!;
  expect(options.open).toBe(false);
  fireEvent.click(screen.getByText('More settings'));
  expect(options.open).toBe(true);
  expect(screen.getByRole('button', { name: 'Collaborate' })).toBeTruthy();
});

it('reopens settings at the account fields while retaining the selected values', () => {
  const view = render(
    <WorkspaceControls {...props} settings={<input aria-label="Account" defaultValue="Work" />}>
      <button>Permissions</button>
    </WorkspaceControls>,
  );
  const trigger = screen.getByRole('button', { name: /^Workspace controls/ });
  fireEvent.click(trigger);
  const body = view.container.querySelector<HTMLElement>('.workspace-controls-content')!;
  const account = screen.getByRole('textbox', { name: 'Account' });
  fireEvent.change(account, { target: { value: 'Personal' } });
  body.scrollTop = 240;
  fireEvent.click(screen.getByRole('button', { name: 'Close agent settings' }));
  fireEvent.click(trigger);
  expect(body.scrollTop).toBe(0);
  expect(screen.getByRole('textbox', { name: 'Account' })).toBe(account);
  expect((account as HTMLInputElement).value).toBe('Personal');
});

it('shows conversation context separately from the compact settings trigger', () => {
  const view = render(
    <WorkspaceControls
      {...props}
      title="New chat"
      agent="Default Mitzo"
      settings={<input aria-label="Account" />}
    >
      <button>Permissions</button>
    </WorkspaceControls>,
  );
  const trigger = screen.getByRole('button', { name: /^Workspace controls/ });
  expect(trigger.textContent).toBe('Settings');
  expect(screen.getByRole('button', { name: /Settings/ })).toBe(trigger);
  expect(trigger.getAttribute('aria-label')).toMatch(/Personal.*Luna.*High/);
  expect(screen.getByText('New chat').closest('button')).toBeNull();
  expect(view.container.querySelector('.workspace-controls-context')?.textContent).toContain(
    'Default Mitzo',
  );
  fireEvent.click(trigger);
  expect(screen.getByRole('region', { name: 'Agent settings' })).toBeTruthy();
});
