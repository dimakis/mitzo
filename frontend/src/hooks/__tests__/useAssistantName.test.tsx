// @vitest-environment jsdom
import { renderHook, act, cleanup } from '@testing-library/react';
import { afterEach, it, expect } from 'vitest';
import { useAssistantName } from '../useAssistantName';
afterEach(() => {
  cleanup();
  localStorage.clear();
});
it('uses Minion by default and updates every mounted adviser immediately', () => {
  const a = renderHook(useAssistantName),
    b = renderHook(useAssistantName);
  expect(a.result.current.name).toBe('Minion');
  act(() => a.result.current.setName('  Brew  '));
  expect(b.result.current.name).toBe('Brew');
  a.unmount();
  b.unmount();
  expect(renderHook(useAssistantName).result.current.name).toBe('Brew');
});
it('restores Minion for an empty name and responds to changes in other tabs', () => {
  const a = renderHook(useAssistantName);
  act(() => a.result.current.setName('  '));
  expect(a.result.current.name).toBe('Minion');
  act(() => {
    localStorage.setItem('mitzo-assistant-name', 'Orbit');
    window.dispatchEvent(new StorageEvent('storage', { key: 'mitzo-assistant-name' }));
  });
  expect(a.result.current.name).toBe('Orbit');
});
