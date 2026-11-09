// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ResizeDivider } from '../ResizeDivider';
afterEach(cleanup);
it('tracks pointer deltas without jumping and stops after cancellation or capture loss', () => {
  const onChange = vi.fn();
  render(
    <ResizeDivider
      label="Resize panel"
      value={200}
      min={100}
      max={400}
      onChange={onChange}
      onReset={() => {}}
    />,
  );
  const divider = screen.getByRole('separator');
  const pointer = (type: string, x: number, id = 1) => {
    const event = new Event(type, { bubbles: true });
    Object.assign(event, { clientX: x, pointerId: id, button: 0 });
    fireEvent(divider, event);
  };
  pointer('pointerdown', 220);
  pointer('pointermove', 260);
  expect(onChange).toHaveBeenLastCalledWith(240);
  pointer('pointermove', 500, 2);
  expect(onChange).toHaveBeenCalledTimes(1);
  pointer('pointercancel', 260);
  pointer('pointermove', 280);
  expect(onChange).toHaveBeenCalledTimes(1);
  pointer('pointerdown', 220);
  pointer('lostpointercapture', 220);
  pointer('pointermove', 300);
  expect(onChange).toHaveBeenCalledTimes(1);
});
it('bounds keyboard resizing and supports reset without submitting a form', () => {
  const onChange = vi.fn(),
    onReset = vi.fn();
  render(
    <ResizeDivider
      label="Resize panel"
      value={395}
      min={100}
      max={400}
      onChange={onChange}
      onReset={onReset}
    />,
  );
  const divider = screen.getByRole('separator');
  fireEvent.keyDown(divider, { key: 'ArrowRight' });
  expect(onChange).toHaveBeenLastCalledWith(400);
  fireEvent.keyDown(divider, { key: 'Home' });
  expect(onChange).toHaveBeenLastCalledWith(100);
  fireEvent.doubleClick(divider);
  expect(onReset).toHaveBeenCalledOnce();
  expect(divider.getAttribute('type')).toBe('button');
});
