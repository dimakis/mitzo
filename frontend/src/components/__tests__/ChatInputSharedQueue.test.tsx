// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { ChatInput } from '../ChatInput';

vi.mock('../SessionResourcesDialog', () => ({ SessionResourcesDialog: () => null }));
vi.mock('../SlashPicker', () => ({ SlashPicker: () => null }));
afterEach(() => {
  cleanup();
  localStorage.clear();
});

it.each(['pointer', 'touch', 'Enter', 'Ctrl+Enter'])(
  'routes shared Queue through its own receipt owner for %s',
  async (gesture) => {
    const send = vi.fn(() => false),
      steer = vi.fn();
    let accepted: (() => void) | undefined;
    const queue = vi.fn<NonNullable<ComponentProps<typeof ChatInput>['onQueue']>>(
      (_text, _images, _context, delivered) => {
        accepted = () => delivered?.('accepted');
        return true;
      },
    );
    render(
      <ChatInput
        running
        onSend={send}
        onQueue={queue}
        onInterrupt={steer}
        onStop={() => {}}
        sharedControl={{ label: 'Reviewer', sourceSelected: false, sourceHandled: false }}
        boundedFirstCommand
        targetedSteering
      />,
    );
    const input = screen.getByRole('textbox', { name: 'Message Mitzo' }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'Queue once' } });
    const button = screen.getByRole('button', { name: 'Queue message' });
    if (gesture === 'touch') {
      fireEvent.touchStart(button);
      fireEvent.touchEnd(button);
      fireEvent.click(button);
    } else if (gesture === 'pointer') {
      fireEvent.pointerDown(button);
      fireEvent.pointerUp(button);
      fireEvent.click(button);
    } else fireEvent.keyDown(input, { key: 'Enter', ctrlKey: gesture === 'Ctrl+Enter' });
    await waitFor(() => expect(queue).toHaveBeenCalledOnce());
    fireEvent.click(button);
    expect(queue).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'Newer draft' } });
    accepted!();
    await waitFor(() => expect(input.value).toBe('Newer draft'));
  },
);
