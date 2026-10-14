// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { onKeyboardToggle } from '../keyboard';
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it('distinguishes an actual shrunken keyboard viewport from ordinary input focus', () => {
  const viewport = Object.assign(new EventTarget(), { height: 844, scale: 1 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerHeight', 844);
  const input = document.createElement('textarea');
  document.body.append(input);
  const changed = vi.fn();
  const dispose = onKeyboardToggle(changed);
  input.focus();
  viewport.dispatchEvent(new Event('resize'));
  expect(changed).toHaveBeenLastCalledWith(false);
  viewport.height = 544;
  viewport.dispatchEvent(new Event('resize'));
  expect(changed).toHaveBeenLastCalledWith(true);
  viewport.height = 844;
  viewport.dispatchEvent(new Event('resize'));
  expect(changed).toHaveBeenLastCalledWith(false);
  dispose();
  changed.mockClear();
  viewport.height = 544;
  viewport.dispatchEvent(new Event('resize'));
  expect(changed).not.toHaveBeenCalled();
});

it('does not treat pinch zoom or ordinary browser chrome as a keyboard', () => {
  const viewport = Object.assign(new EventTarget(), { height: 500, scale: 2 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerHeight', 844);
  const input = document.createElement('textarea');
  document.body.append(input);
  input.focus();
  const changed = vi.fn();
  const dispose = onKeyboardToggle(changed);
  expect(changed).toHaveBeenLastCalledWith(false);
  viewport.scale = 1;
  viewport.height = 780;
  viewport.dispatchEvent(new Event('resize'));
  expect(changed).toHaveBeenLastCalledWith(false);
  dispose();
});
