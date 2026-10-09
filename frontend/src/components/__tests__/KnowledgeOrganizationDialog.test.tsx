// @vitest-environment jsdom
import React from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
