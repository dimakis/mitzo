// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { useFileEditor } from '../useFileEditor';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => fn());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function editor(content = 'original', session = 'vertex') {
  return renderHook(() => useFileEditor(content, 'report.md', vi.fn(), session));
}
describe('document editing', () => {
  it.each(['vertex', 'openai-api', 'openai-subscription'])(
    'saves %s with original content and keeps the editor open',
    async (session) => {
      vi.mocked(apiFetch).mockResolvedValue(new Response('{}'));
      const { result } = editor('original', session);
      act(() => result.current.startEditing());
      act(() => result.current.handleEditChange('updated'));
      const saved = vi.fn();
      await act(() => result.current.saveFile(saved));
      expect(JSON.parse(vi.mocked(apiFetch).mock.calls.at(-1)![1]!.body as string)).toEqual({
        path: 'report.md',
        content: 'updated',
        expectedContent: 'original',
        sessionId: session,
      });
      expect(saved).toHaveBeenCalledWith('updated');
      expect(result.current.editing).toBe(true);
      expect(result.current.dirty).toBe(false);
    },
  );
  it('keeps a conflicted draft visible and editable', async () => {
    vi.mocked(apiFetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'File changed elsewhere' }), { status: 409 }),
    );
    const { result } = editor();
    act(() => result.current.startEditing());
    act(() => result.current.handleEditChange('draft'));
    await act(() => result.current.saveFile(vi.fn()));
    expect(result.current.error).toBe('File changed elsewhere');
    expect(result.current.editContent).toBe('draft');
    expect(result.current.dirty).toBe(true);
  });
  it('recovers a draft after remount and preserves its original conflict baseline', async () => {
    const first = editor();
    act(() => first.result.current.startEditing());
    act(() => first.result.current.handleEditChange('recovered'));
    first.unmount();
    const next = editor('changed by agent');
    act(() => next.result.current.startEditing());
    expect(next.result.current.editContent).toBe('recovered');
    vi.mocked(apiFetch).mockResolvedValue(new Response('{}'));
    await act(() => next.result.current.saveFile(vi.fn()));
    expect(
      JSON.parse(vi.mocked(apiFetch).mock.calls.at(-1)![1]!.body as string).expectedContent,
    ).toBe('original');
  });
  it('supports undo and redo, and scopes drafts to the conversation', () => {
    const first = editor();
    act(() => first.result.current.startEditing());
    act(() => first.result.current.handleEditChange('one'));
    act(() => first.result.current.handleEditChange('two'));
    act(() => first.result.current.undo());
    expect(first.result.current.editContent).toBe('one');
    act(() => first.result.current.redo());
    expect(first.result.current.editContent).toBe('two');
    const other = editor('different', 'other');
    act(() => other.result.current.startEditing());
    expect(other.result.current.editContent).toBe('different');
  });
  it('disables cancellation and changes during an in-flight save', async () => {
    let finish!: (value: Response) => void;
    vi.mocked(apiFetch).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { result } = editor();
    act(() => result.current.startEditing());
    act(() => result.current.handleEditChange('saved'));
    let saving!: Promise<void>;
    act(() => {
      saving = result.current.saveFile(vi.fn());
    });
    act(() => result.current.cancelEditing());
    act(() => result.current.handleEditChange('lost'));
    expect(result.current.editing).toBe(true);
    expect(result.current.editContent).toBe('saved');
    await act(async () => {
      finish(new Response('{}'));
      await saving;
    });
  });
});
