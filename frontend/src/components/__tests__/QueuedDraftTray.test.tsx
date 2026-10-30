// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { chatStorage } from '../../lib/large-chat-storage';
import { QueuedDraftTray } from '../QueuedDraftTray';
import type { ReactNode } from 'react';
vi.mock('../HomeDialog', () => ({
  HomeDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="dialog">{children}</div> : null,
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('does not close a newer queued-prompt editor when an earlier save finishes', async () => {
  let finish!: () => void;
  vi.spyOn(chatStorage, 'flush').mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const queue = ['First', 'Second'].map((text, index) => ({
    queueEntryId: `q-${index}`,
    text,
    images: [],
    contextBlocks: [],
  }));
  render(
    <QueuedDraftTray
      queue={queue}
      paused={false}
      busy={false}
      running
      blocked={false}
      textOnlySteer
      onPause={vi.fn()}
      onSend={vi.fn()}
      onUpdate={() => true}
      onRemove={vi.fn()}
      onEditingChange={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Edit, reorder or remove queued prompt 1' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Edit, reorder or remove queued prompt 2' }));
  const input = screen.getByRole('textbox', { name: 'Prompt' });
  fireEvent.change(input, { target: { value: 'New unsaved edit' } });
  await act(async () => finish());
  expect(screen.getByRole('dialog')).toBeDefined();
  expect(input).toHaveValue('New unsaved edit');
});
