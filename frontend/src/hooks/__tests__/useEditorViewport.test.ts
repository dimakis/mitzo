// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useEditorViewport } from '../useEditorViewport';
it('keeps the document controls inside the visual viewport when the mobile keyboard opens', () => {
  const viewport = Object.assign(new EventTarget(), { height: 700, offsetTop: 0 });
  vi.stubGlobal('visualViewport', viewport);
  const element = document.createElement('div');
  const { result, unmount } = renderHook(() => useEditorViewport());
  result.current.current = element;
  viewport.height = 350;
  viewport.offsetTop = 20;
  act(() => viewport.dispatchEvent(new Event('resize')));
  expect(element.style.height).toBe('350px');
  expect(element.style.top).toBe('20px');
  unmount();
  vi.unstubAllGlobals();
});
