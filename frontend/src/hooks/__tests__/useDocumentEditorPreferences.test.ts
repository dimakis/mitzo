// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDocumentEditorPreferences } from '../useDocumentEditorPreferences';

function pointer(keyboard: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: keyboard && query === '(any-hover: hover) and (any-pointer: fine)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}
beforeEach(() => {
  localStorage.clear();
  pointer(false);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('document editor preferences', () => {
  it('remembers desktop Vim without enabling it on touch devices', () => {
    pointer(true);
    const desktop = renderHook(useDocumentEditorPreferences);
    expect(desktop.result.current.keyboard).toBe(true);
    expect(desktop.result.current.vim).toBe(false);
    act(() => desktop.result.current.setVim(true));
    desktop.unmount();
    const remembered = renderHook(useDocumentEditorPreferences);
    expect(remembered.result.current.vim).toBe(true);
    remembered.unmount();
    pointer(false);
    const mobile = renderHook(useDocumentEditorPreferences);
    expect(mobile.result.current.vim).toBe(false);
    act(() => mobile.result.current.setVim(true));
    mobile.unmount();
    expect(renderHook(useDocumentEditorPreferences).result.current.vim).toBe(true);
  });
  it('uses pointer capability even when the desktop window is narrow', () => {
    pointer(true);
    Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true });
    expect(renderHook(useDocumentEditorPreferences).result.current.keyboard).toBe(true);
  });
  it('keeps editing preferences usable when storage fails', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    const { result } = renderHook(useDocumentEditorPreferences);
    act(() => {
      result.current.setVim(true);
      result.current.setRelativeLineNumbers(true);
    });
    expect(result.current.vim).toBe(true);
    expect(result.current.relativeLineNumbers).toBe(true);
  });
});
