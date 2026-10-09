// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { initAppearance, useAppearance } from '../useAppearance';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-accent');
  document.documentElement.removeAttribute('data-font');
});
afterEach(cleanup);
it('applies a selected accent and font immediately and restores them on startup', () => {
  const { result, unmount } = renderHook(useAppearance);
  act(() => result.current.setAccent('teal'));
  act(() => result.current.setFont('georgia'));
  expect(document.documentElement.dataset.accent).toBe('teal');
  expect(document.documentElement.dataset.font).toBe('georgia');
  expect(localStorage.getItem('mitzo-accent')).toBe('teal');
  expect(localStorage.getItem('mitzo-font')).toBe('georgia');
  unmount();
  document.documentElement.removeAttribute('data-accent');
  document.documentElement.removeAttribute('data-font');
  initAppearance();
  expect(document.documentElement.dataset.accent).toBe('teal');
  expect(document.documentElement.dataset.font).toBe('georgia');
});
it('falls back from invalid saved preferences and resets both choices', () => {
  localStorage.setItem('mitzo-accent', 'obsolete');
  localStorage.setItem('mitzo-font', 'unavailable');
  initAppearance();
  expect(document.documentElement.dataset.accent).toBe('lavender');
  expect(document.documentElement.dataset.font).toBe('system');
  const { result } = renderHook(useAppearance);
  act(() => {
    result.current.setAccent('rose');
    result.current.setFont('arial');
  });
  act(() => result.current.reset());
  expect(document.documentElement.dataset.accent).toBe('lavender');
  expect(document.documentElement.dataset.font).toBe('system');
});

it.each([
  ['blue', 'verdana'],
  ['mint', 'trebuchet'],
  ['coral', 'palatino'],
  ['plum', 'courier'],
])('restores the new %s accent and %s font before rendering', (accent, font) => {
  localStorage.setItem('mitzo-accent', accent);
  localStorage.setItem('mitzo-font', font);
  initAppearance();
  expect(document.documentElement.dataset.accent).toBe(accent);
  expect(document.documentElement.dataset.font).toBe(font);
});
