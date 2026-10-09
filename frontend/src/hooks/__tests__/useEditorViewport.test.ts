// @vitest-environment jsdom
import { createElement } from 'react';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useEditorViewport } from '../useEditorViewport';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
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

it('fits the workspace body and its visible intersection when the keyboard resizes or pans', () => {
  const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
  vi.stubGlobal('visualViewport', viewport);
  let bodyBottom = 780;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ top: 64, bottom: bodyBottom }) as DOMRect,
  );
  let onResize!: ResizeObserverCallback;
  const disconnect = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        onResize = callback;
      }
      observe = vi.fn();
      disconnect = disconnect;
    },
  );
  function Viewer() {
    const ref = useEditorViewport();
    return createElement(
      'div',
      { className: 'mobile-workspace-body' },
      createElement('div', { ref, 'data-testid': 'viewer' }),
    );
  }
  const { getByTestId, unmount } = render(createElement(Viewer));
  const viewer = getByTestId('viewer');
  expect(viewer.style.height).toBe('716px');
  expect(viewer.style.top).toBe('0px');
  viewport.height = 350;
  viewport.offsetTop = 20;
  act(() => viewport.dispatchEvent(new Event('resize')));
  expect(viewer.style.height).toBe('306px');
  expect(viewer.style.top).toBe('0px');
  viewport.offsetTop = 100;
  act(() => viewport.dispatchEvent(new Event('scroll')));
  expect(viewer.style.height).toBe('350px');
  expect(viewer.style.top).toBe('36px');
  bodyBottom = 400;
  act(() => onResize([], {} as ResizeObserver));
  expect(viewer.style.height).toBe('300px');
  unmount();
  expect(disconnect).toHaveBeenCalledOnce();
  viewport.height = 844;
  act(() => viewport.dispatchEvent(new Event('resize')));
  expect(viewer.style.height).toBe('300px');
});
