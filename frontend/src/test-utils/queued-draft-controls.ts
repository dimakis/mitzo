import { expect } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
// jsdom has no native modal implementation. Focus/motion/geometry are covered
// by the offline Playwright fixture; these helpers exercise composer ownership.
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute('open');
};
export async function queueDraft() {
  const input = screen.getByLabelText('Message Mitzo');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
  });
  await waitFor(() => expect(input).toHaveProperty('value', ''));
}
export async function sendQueued(index = 0) {
  await act(async () => {
    fireEvent.click(
      screen.getByRole('button', {
        name: new RegExp(`^(?:Steer with|Send) queued prompt ${index + 1}$`),
      }),
    );
  });
}
export async function openQueuedEditor(index?: number) {
  const choices = screen.getAllByRole('button', { name: /^Edit, reorder or remove queued prompt/ });
  await act(async () => {
    fireEvent.click(index === undefined ? choices.at(-1)! : choices[index]);
  });
  return screen.getByRole('textbox', { name: 'Prompt' });
}
export async function saveQueuedEditor() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  });
}
