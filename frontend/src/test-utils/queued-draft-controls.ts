import { expect } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
// jsdom has no native modal implementation. Focus/motion/geometry are covered
// by the offline Playwright fixture; these helpers exercise composer ownership.
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute('open');
};
export function reviewQueue() {
  if (!screen.queryByRole('region', { name: 'Up next' })) {
    const trigger = screen.queryByRole('button', { name: /^\d+ queued messages?$/ });
    if (trigger) fireEvent.click(trigger);
  }
}
export function sendCorrection() {
  fireEvent.click(
    screen.getByRole('button', { name: /^(Interrupt and send now|Steer current turn)$/ }),
  );
}
export function queuedButton(name: string | RegExp) {
  reviewQueue();
  return screen.getByRole('button', { name });
}
export function queuedRegion() {
  reviewQueue();
  return screen.getByRole('region', { name: 'Up next' });
}
export function queuedText(text: string) {
  return within(queuedRegion()).getByText(text);
}
export function statusButton(name: string) {
  if (!screen.queryByRole('button', { name }))
    fireEvent.click(screen.getByRole('button', { name: 'Conversation status details' }));
  return screen.getByRole('button', { name });
}
export async function queueDraft() {
  const input = screen.getByLabelText('Message Mitzo');
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Queue message' }));
  });
  await waitFor(() => expect(input).toHaveProperty('value', ''));
  reviewQueue();
}
export async function sendQueued(index = 0) {
  reviewQueue();
  await act(async () => {
    fireEvent.click(
      screen.getByRole('button', {
        name: new RegExp(`^(?:Steer with|Send) queued prompt ${index + 1}$`),
      }),
    );
  });
}
export async function openQueuedEditor(index?: number) {
  reviewQueue();
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
