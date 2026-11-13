// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SnapSheet } from '../SnapSheet';

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('snaps a dragged surface to full height or hidden and cancels without losing its draft', () => {
  const close = vi.fn();
  render(
    <SnapSheet title="Peirce" onClose={close}>
      <textarea aria-label="Draft" defaultValue="Keep this" />
    </SnapSheet>,
  );
  const dialog = screen.getByRole('dialog', { name: 'Peirce' });
  vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({ height: 400 } as DOMRect);
  const grip = dialog.querySelector('.snap-sheet-grip')!;
  const pointer = (type: string, y: number) =>
    fireEvent(grip, new MouseEvent(type, { bubbles: true, clientY: y, button: 0 }));
  pointer('pointerdown', 500);
  pointer('pointermove', 0);
  pointer('pointerup', 0);
  expect(dialog.getAttribute('data-snap')).toBe('full');
  pointer('pointerdown', 200);
  pointer('pointermove', 300);
  pointer('pointercancel', 300);
  expect(dialog.getAttribute('data-dragging')).toBeNull();
  expect(dialog.style.getPropertyValue('--snap-sheet-drag-height')).toBe('');
  expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveProperty('value', 'Keep this');
  pointer('pointerdown', 100);
  pointer('pointermove', 800);
  pointer('pointerup', 800);
  expect(close).toHaveBeenCalledOnce();
});
