// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { KnowledgeOrganizationDialog } from '../KnowledgeOrganizationDialog';
afterEach(cleanup);
it('checks folder parents by scope instead of probing a potentially occupied name', () => {
  render(
    <KnowledgeOrganizationDialog
      mode="folder"
      directories={['hub']}
      initialParent=""
      busy={false}
      canChooseParent={(parent) => parent === 'hub'}
      canChoose={(path) => path === 'hub/fresh'}
      onSubmit={() => true}
      onClose={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Folder hub' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Folder name' }), {
    target: { value: 'fresh' },
  });
  expect(
    (screen.getByRole('button', { name: 'Create folder' }) as HTMLButtonElement).disabled,
  ).toBe(false);
});
it('shows ancestors of enrolled folders without allowing them as creation parents', () => {
  render(
    <KnowledgeOrganizationDialog
      mode="folder"
      directories={['hub', 'hub/context']}
      initialParent=""
      busy={false}
      canChooseParent={(parent) => parent === 'hub/context'}
      canChoose={(path) => path.startsWith('hub/context/')}
      onSubmit={() => true}
      onClose={() => {}}
    />,
  );
  const root = screen.getByRole('button', { name: 'Folder hub' });
  expect(root.getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(root);
  fireEvent.change(screen.getByRole('textbox', { name: 'Folder name' }), {
    target: { value: 'fresh' },
  });
  expect(
    (screen.getByRole('button', { name: 'Create folder' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Expand folder hub' }));
  fireEvent.click(screen.getByRole('button', { name: 'Folder hub/context' }));
  expect(
    (screen.getByRole('button', { name: 'Create folder' }) as HTMLButtonElement).disabled,
  ).toBe(false);
});

it('waits for Move confirmation and keeps the dialog open on an unsuccessful submission', async () => {
  let finish!: (value: boolean) => void;
  const result = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  const close = vi.fn();
  const submit = vi.fn(() => result);
  render(
    <KnowledgeOrganizationDialog
      mode="move"
      directories={['hub', 'hub/context']}
      initialParent="hub"
      source="hub/guide.md"
      busy={false}
      canChoose={() => true}
      onSubmit={submit}
      onClose={close}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Folder hub/context' }));
  fireEvent.click(screen.getByRole('button', { name: 'Move here' }));
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Move here' }));
  fireEvent.keyDown(screen.getByRole('dialog', { name: 'Move document' }), { key: 'Escape' });
  fireEvent.click(screen.getByRole('dialog', { name: 'Move document' }).parentElement!);
  expect(submit).toHaveBeenCalledTimes(1);
  expect(close).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => {
    finish(false);
  });
  expect(close).not.toHaveBeenCalled();
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Move here' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
});

it('shows an unexpected confirmation error and permits retry without closing', async () => {
  const close = vi.fn();
  render(
    <KnowledgeOrganizationDialog
      mode="move"
      directories={['hub', 'hub/context']}
      initialParent="hub"
      source="hub/guide.md"
      busy={false}
      canChoose={() => true}
      onSubmit={async () => {
        throw new Error('Move unavailable');
      }}
      onClose={close}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Folder hub/context' }));
  fireEvent.click(screen.getByRole('button', { name: 'Move here' }));
  await screen.findByText('Move unavailable');
  expect(close).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: 'Move here' }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});
