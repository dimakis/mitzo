// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useSessionDisplay } from '../useSessionDisplay';
afterEach(() => {
  cleanup();
  localStorage.clear();
});
it('migrates the Today token preference and propagates appearance changes between consumers', () => {
  localStorage.setItem('mitzo-today-tokens', 'true');
  const first = renderHook(() => useSessionDisplay());
  const second = renderHook(() => useSessionDisplay());
  expect(first.result.current.showContext).toBe(true);
  act(() => first.result.current.setShowContext(false));
  expect(second.result.current.showContext).toBe(false);
  expect(localStorage.getItem('mitzo-today-tokens')).toBe('false');
});
