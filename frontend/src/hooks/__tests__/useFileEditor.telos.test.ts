// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useFileEditor } from '../useFileEditor';
import { apiFetch } from '../../lib/api-fetch';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
const path = '/api/telos/artifacts/' + 'a'.repeat(32) + '?revision=1';
const endpoint = path.split('?')[0] + '/document';
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const receipt = (revision: number) => ({
  artifact: {
    id: 'a'.repeat(32),
    revision,
    url: path.replace('revision=1', `revision=${revision}`),
  },
});
function open(content = '# Original', revision = 1) {
  return renderHook(() =>
    useFileEditor(
      content,
      path.replace('revision=1', `revision=${revision}`),
      vi.fn(),
      undefined,
      revision,
    ),
  );
}
beforeEach(() => {
  sessionStorage.clear();
  vi.resetAllMocks();
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => fn());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('saves against the viewed revision through Telos and returns the newly pinned URL', async () => {
  vi.mocked(apiFetch).mockResolvedValue(response(receipt(2)));
  const { result } = open();
  act(() => result.current.startEditing());
  act(() => result.current.handleEditChange('# Edited'));
  const saved = vi.fn();
  await act(() => result.current.saveFile(saved));
  expect(apiFetch).toHaveBeenCalledWith(endpoint, expect.objectContaining({ method: 'PUT' }));
  expect(JSON.parse(vi.mocked(apiFetch).mock.calls[0][1]!.body as string)).toMatchObject({
    expectedRevision: 1,
    content: '# Edited',
    requestId: expect.any(String),
  });
  expect(saved).toHaveBeenCalledWith('# Edited', receipt(2).artifact.url);
  expect(result.current.dirty).toBe(false);
});

it('retains one save identity across uncertain failure and draft recovery', async () => {
  vi.mocked(apiFetch).mockRejectedValue(new Error('Connection lost'));
  const first = open();
  act(() => first.result.current.startEditing());
  act(() => first.result.current.handleEditChange('# Draft'));
  await act(() => first.result.current.saveFile(vi.fn()));
  const original = vi.mocked(apiFetch).mock.calls[0][1]!.body;
  expect(JSON.parse(original as string)).toMatchObject({
    expectedRevision: 1,
    requestId: expect.any(String),
  });
  first.unmount();
  const next = open('# Newer', 2);
  act(() => next.result.current.startEditing());
  expect(next.result.current.editContent).toBe('# Draft');
  vi.mocked(apiFetch).mockResolvedValue(response(receipt(2)));
  await act(() => next.result.current.saveFile(vi.fn()));
  expect(vi.mocked(apiFetch).mock.calls[1][1]!.body).toBe(original);
});

it.each([false, true])(
  'reviews latest metadata and resolves a conflict (replace draft: %s)',
  async (replace) => {
    const { result } = open();
    act(() => result.current.startEditing());
    act(() => result.current.handleEditChange('# Draft'));
    vi.mocked(apiFetch).mockResolvedValueOnce(
      response({ error: 'A newer revision is available' }, 409),
    );
    await act(() => result.current.saveFile(vi.fn()));
    const firstRequest = JSON.parse(vi.mocked(apiFetch).mock.calls[0][1]!.body as string).requestId;
    expect(result.current.dirty).toBe(true);
    vi.mocked(apiFetch).mockResolvedValueOnce(response({ content: '# Latest', revision: 3 }));
    await act(() => result.current.reviewLatest());
    expect(vi.mocked(apiFetch).mock.calls[1][0]).toBe(endpoint);
    act(() => result.current.resolveConflict(replace));
    expect(result.current.editContent).toBe(replace ? '# Latest' : '# Draft');
    act(() => result.current.handleEditChange('# Final draft'));
    vi.mocked(apiFetch).mockResolvedValueOnce(response(receipt(4)));
    await act(() => result.current.saveFile(vi.fn()));
    const input = JSON.parse(vi.mocked(apiFetch).mock.calls[2][1]!.body as string);
    expect(input.expectedRevision).toBe(3);
    expect(input.requestId).not.toBe(firstRequest);
  },
);

it.each([false, true])(
  'opens the reviewed baseline after finishing or discarding a rebased draft (%s)',
  async (discard) => {
    const { result } = open();
    act(() => result.current.startEditing());
    act(() => result.current.handleEditChange('# Draft'));
    vi.mocked(apiFetch).mockResolvedValue(response({ content: '# Draft', revision: 3 }));
    await act(() => result.current.reviewLatest());
    act(() => result.current.resolveConflict(false));
    expect(result.current.dirty).toBe(false);
    if (discard) {
      act(() => result.current.handleEditChange('# Another draft'));
      vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    }
    const opened = vi.fn();
    act(() => result.current.cancelEditing(opened));
    expect(opened).toHaveBeenCalledWith('# Draft', path.replace('revision=1', 'revision=3'));
    expect(result.current.editing).toBe(false);
  },
);

it('retains the draft when a save receipt is missing or belongs to another document', async () => {
  const { result } = open();
  act(() => result.current.startEditing());
  act(() => result.current.handleEditChange('# Draft'));
  const saved = vi.fn();
  vi.mocked(apiFetch).mockResolvedValue(response({}));
  await act(() => result.current.saveFile(saved));
  expect(result.current.dirty).toBe(true);
  expect(result.current.error).toBeTruthy();
  expect(saved).not.toHaveBeenCalled();
});

it('does not navigate or remove a recovered draft when an old mounted editor finishes saving', async () => {
  let finish!: (response: Response) => void;
  vi.mocked(apiFetch).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const first = open();
  act(() => first.result.current.startEditing());
  act(() => first.result.current.handleEditChange('# Draft'));
  const saved = vi.fn();
  let saving!: Promise<void>;
  act(() => {
    saving = first.result.current.saveFile(saved);
  });
  first.unmount();
  await act(async () => {
    finish(response(receipt(2)));
    await saving;
  });
  expect(saved).not.toHaveBeenCalled();
  const next = open();
  act(() => next.result.current.startEditing());
  expect(next.result.current.editContent).toBe('# Draft');
});

it('saves on remote HTTP where randomUUID is unavailable', async () => {
  vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
  vi.mocked(apiFetch).mockResolvedValue(response(receipt(2)));
  const { result } = open();
  act(() => result.current.startEditing());
  act(() => result.current.handleEditChange('# HTTP draft'));
  await act(() => result.current.saveFile(vi.fn()));
  expect(result.current.error).toBe('');
  expect(result.current.dirty).toBe(false);
});

it.each([false, true])(
  'keeps displayed bytes and revision aligned after conflict resolution (%s)',
  async (replace) => {
    const { result } = open();
    act(() => result.current.startEditing());
    act(() => result.current.handleEditChange('# Draft'));
    vi.mocked(apiFetch).mockResolvedValue(response({ content: '# Latest', revision: 3 }));
    await act(() => result.current.reviewLatest());
    const latest = vi.fn();
    act(() => result.current.resolveConflict(replace, latest));
    if (replace)
      expect(latest).toHaveBeenCalledWith('# Latest', path.replace('revision=1', 'revision=3'));
    else expect(latest).not.toHaveBeenCalled();
  },
);
