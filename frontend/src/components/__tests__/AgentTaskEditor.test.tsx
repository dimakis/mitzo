// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { AgentTaskEditor } from '../AgentTaskEditor';
import {
  createAgentTaskWorkingCopy,
  type AgentTaskWorkingCopy,
} from '../../lib/agent-task-working-copy';

vi.mock('../AgentTaskSettings', () => ({
  AgentTaskSettings: () => <p>Existing independent execution settings</p>,
}));
afterEach(cleanup);
const profile = {
  profileId: 'bob',
  revision: 3,
  contentHash: 'a'.repeat(64),
  definition: {
    name: 'Bob',
    role: 'agent',
    instructions: 'Review evidence',
    expectedOutput: 'Brief',
    acceptanceCriteria: ['Cite sources'],
    modelPolicyRole: 'agent',
  },
};
const seed = {
  ...createAgentTaskWorkingCopy(profile),
  name: 'Morning review',
  objective: 'Review accepted evidence.',
  workspaceId: 'retained-workspace',
  sourceRefs: 'report-r3',
  notificationPolicy: 'failures' as const,
};

it('keeps Library task heading/close and save/cancel in one detail panel, with advanced fields on request', () => {
  const close = vi.fn(),
    save = vi.fn();
  function Editor() {
    const [copy, update] = useState<AgentTaskWorkingCopy>(seed);
    return (
      <AgentTaskEditor
        copy={copy}
        versions={[profile]}
        update={update}
        save={save}
        busy={false}
        onClose={close}
      />
    );
  }
  render(<Editor />);
  const editor = screen.getByRole('region', { name: 'Task editor' });
  expect(within(editor).getByRole('heading', { name: 'Assign a task' })).toBeTruthy();
  expect(
    within(editor).getByRole('button', { name: 'Close task editor' }).closest('header'),
  ).toBeTruthy();
  expect(within(editor).getByRole('button', { name: 'Save task' }).closest('footer')).toBeTruthy();
  expect(within(editor).getByRole('button', { name: 'Cancel' }).closest('footer')).toBeTruthy();
  expect(
    (
      within(editor)
        .getByRole('textbox', { name: 'Workspace reference' })
        .closest('details') as HTMLDetailsElement
    ).open,
  ).toBe(false);
  fireEvent.click(within(editor).getByText('Workspace and notifications'));
  expect(
    (screen.getByRole('textbox', { name: 'Workspace reference' }) as HTMLInputElement).value,
  ).toBe('retained-workspace');
  expect(
    (
      screen.getByRole('textbox', {
        name: 'Source references (one per line)',
      }) as HTMLTextAreaElement
    ).value,
  ).toBe('report-r3');
  fireEvent.change(screen.getByRole('textbox', { name: 'Workspace reference' }), {
    target: { value: 'unfinished-workspace' },
  });
  fireEvent.click(screen.getByText('Workspace and notifications'));
  fireEvent.click(screen.getByText('Workspace and notifications'));
  expect(
    (screen.getByRole('textbox', { name: 'Workspace reference' }) as HTMLInputElement).value,
  ).toBe('unfinished-workspace');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(close).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();
});

it('keeps authoritative retry actions outside locked fields and never turns close into a save', () => {
  const retry = vi.fn(),
    close = vi.fn(),
    save = vi.fn();
  render(
    <AgentTaskEditor
      copy={seed}
      versions={[profile]}
      update={() => {}}
      save={save}
      busy={false}
      disabled
      onClose={close}
      footerActions={
        <button onClick={retry} type="button">
          Retry task save
        </button>
      }
    />,
  );
  expect(
    (screen.getByRole('textbox', { name: 'Task name' }) as HTMLInputElement).closest('fieldset')!
      .disabled,
  ).toBe(true);
  expect((screen.getByRole('button', { name: 'Save task' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(
    (screen.getByRole('button', { name: 'Retry task save' }) as HTMLButtonElement).disabled,
  ).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Retry task save' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close task editor' }));
  expect(retry).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();
});
