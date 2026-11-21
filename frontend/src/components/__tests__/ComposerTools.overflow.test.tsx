// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ComposerTools } from '../ComposerTools';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('returns focus to an inline control when resizing makes the More trigger disappear', () => {
  let mode = 'popover';
  const realStyle = window.getComputedStyle;
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
    const style = realStyle(element);
    if (element.classList.contains('composer-tools-anchor'))
      vi.spyOn(style, 'getPropertyValue').mockImplementation(() => mode);
    return style;
  });
  render(<Surface />);
  screen.getByRole('button', { name: 'More composer actions' }).focus();
  mode = 'inline';
  fireEvent(window, new Event('resize'));
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Commands' }));
  mode = 'popover';
  fireEvent(window, new Event('resize'));
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'More composer actions' }),
  );
});

it('retains the overflow behind a portaled dialog so its original control can regain focus', () => {
  const realStyle = window.getComputedStyle;
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
    const style = realStyle(element);
    if (element.classList.contains('composer-tools-anchor'))
      vi.spyOn(style, 'getPropertyValue').mockReturnValue('popover');
    return style;
  });
  render(
    <>
      <Surface />
      {createPortal(
        <dialog open>
          <button>Dialog action</button>
        </dialog>,
        document.body,
      )}
    </>,
  );
  const toggle = screen.getByRole('button', { name: 'More composer actions' });
  fireEvent.click(toggle);
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Dialog action' }));
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
});

function Surface() {
  const [value, setValue] = useState('retained');
  return (
    <ComposerTools
      onCommands={() => {}}
      commandsExpanded={false}
      onAttach={() => {}}
      attachmentDisabled={false}
      onDismiss={() => {}}
    >
      <label>
        Secondary draft
        <input value={value} onChange={(e) => setValue(e.target.value)} />
      </label>
      <button type="button">Resources</button>
    </ComposerTools>
  );
}

it('keeps secondary controls mounted while overflow is closed and restores focus on Escape', () => {
  const realStyle = window.getComputedStyle;
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
    const style = realStyle(element);
    if (element.classList.contains('composer-tools-anchor'))
      vi.spyOn(style, 'getPropertyValue').mockReturnValue('popover');
    return style;
  });
  render(<Surface />);
  const toggle = screen.getByRole('button', { name: 'More composer actions' });
  expect(screen.queryByRole('button', { name: 'Resources' })).toBeNull();
  fireEvent.click(toggle);
  expect(screen.getByRole('button', { name: 'Resources' })).toBeTruthy();
  const input = screen.getByLabelText('Secondary draft') as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'edited once' } });
  input.focus();
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(document.activeElement).toBe(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('button', { name: 'Resources' })).toBeNull();
  fireEvent.click(toggle);
  expect(screen.getByLabelText('Secondary draft')).toBe(input);
  expect(input.value).toBe('edited once');
});
