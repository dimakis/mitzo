// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api-fetch', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../api-fetch';
import { Capacitor } from '@capacitor/core';
import { shareFile } from '../share-file';

const mockApiFetch = vi.mocked(apiFetch);

describe('shareFile', () => {
  let appendChildSpy: ReturnType<typeof vi.spyOn>;
  let removeChildSpy: ReturnType<typeof vi.spyOn>;
  let createObjectURLSpy: ReturnType<typeof vi.spyOn>;
  let revokeObjectURLSpy: ReturnType<typeof vi.spyOn>;
  let clickedHrefs: string[];

  beforeEach(() => {
    clickedHrefs = [];
    appendChildSpy = vi.spyOn(document.body, 'appendChild').mockImplementation((node) => node);
    removeChildSpy = vi.spyOn(document.body, 'removeChild').mockImplementation((node) => node);
    createObjectURLSpy = vi.fn().mockReturnValue('blob:test-url') as unknown as ReturnType<
      typeof vi.spyOn
    >;
    revokeObjectURLSpy = vi.fn() as unknown as ReturnType<typeof vi.spyOn>;
    globalThis.URL.createObjectURL = createObjectURLSpy as unknown as typeof URL.createObjectURL;
    globalThis.URL.revokeObjectURL = revokeObjectURLSpy as unknown as typeof URL.revokeObjectURL;

    // Mock createElement to capture click
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreate(tag);
      if (tag === 'a') {
        vi.spyOn(el as HTMLAnchorElement, 'click').mockImplementation(() => {
          clickedHrefs.push((el as HTMLAnchorElement).href);
        });
      }
      return el;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('downloads file and triggers browser download when canShare is unavailable', async () => {
    const blob = new Blob(['# Hello'], { type: 'application/octet-stream' });
    mockApiFetch.mockResolvedValue(new Response(blob, { status: 200 }));

    // Ensure no native share
    Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true });

    const result = await shareFile('/workspace/report.md');

    expect(mockApiFetch).toHaveBeenCalledWith('/api/files/download?path=%2Fworkspace%2Freport.md');
    expect(appendChildSpy).toHaveBeenCalled();
    expect(removeChildSpy).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  it('uses native share when canShare returns true', async () => {
    const blob = new Blob(['data'], { type: 'text/plain' });
    mockApiFetch.mockResolvedValue(new Response(blob, { status: 200 }));

    const shareFn = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'canShare', {
      value: () => true,
      configurable: true,
    });
    Object.defineProperty(navigator, 'share', {
      value: shareFn,
      configurable: true,
    });

    const result = await shareFile('/workspace/notes.txt');

    expect(shareFn).toHaveBeenCalled();
    const callArg = shareFn.mock.calls[0][0];
    expect(callArg.files).toHaveLength(1);
    expect(callArg.files[0].name).toBe('notes.txt');
    expect(result).toBe(true);
  });

  it('scopes generated artifact downloads to their session', async () => {
    const blob = new Blob(['artifact'], { type: 'text/plain' });
    mockApiFetch.mockResolvedValue(new Response(blob, { status: 200 }));
    Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true });

    await shareFile('/workspace/report.md', 'session-1');

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/files/download?path=%2Fworkspace%2Freport.md&sessionId=session-1',
    );
  });

  it('reuses prepared bytes on a second tap after user activation expires', async () => {
    mockApiFetch.mockResolvedValue(
      new Response(new Blob(['# Exact bytes\n']), {
        headers: { 'Content-Type': 'application/octet-stream' },
      }),
    );
    const share = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('Gesture expired', 'NotAllowedError'))
      .mockResolvedValueOnce(undefined);
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    const before = mockApiFetch.mock.calls.length;
    await expect(shareFile('slow-report.md', 'old')).rejects.toThrow('Tap Share again');
    await shareFile('slow-report.md', 'old');
    expect(mockApiFetch.mock.calls.length - before).toBe(1);
    expect(share.mock.calls[0][0].files[0]).toBe(share.mock.calls[1][0].files[0]);
    expect(share.mock.calls[1][0].files[0].type).toBe('text/markdown');
  });

  it('does not let an older pending share replace the latest prepared retry', async () => {
    mockApiFetch.mockImplementation(async () => new Response('bytes'));
    let rejectOld!: (reason: Error) => void;
    const share = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            rejectOld = reject;
          }),
      )
      .mockRejectedValueOnce(new DOMException('Gesture expired', 'NotAllowedError'))
      .mockResolvedValueOnce(undefined);
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    const old = shareFile('old.md');
    const oldResult = old.catch((error: unknown) => error);
    await vi.waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    await expect(shareFile('new.md')).rejects.toThrow('Tap Share again');
    rejectOld(new DOMException('Gesture expired', 'NotAllowedError'));
    expect(await oldResult).toMatchObject({ message: 'Tap Share again to open the share sheet.' });
    const before = mockApiFetch.mock.calls.length;
    await shareFile('new.md');
    expect(mockApiFetch.mock.calls.length).toBe(before);
    expect(share.mock.calls[2][0].files[0]).toBe(share.mock.calls[1][0].files[0]);
  });

  it('does not open a stale share sheet when an older download completes last', async () => {
    let finishOld!: (response: Response) => void;
    mockApiFetch
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockImplementation(async () => new Response('new bytes'));
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    const old = shareFile('old-download.md');
    expect(await shareFile('new-download.md')).toBe(true);
    finishOld(new Response('old bytes'));
    expect(await old).toBe(false);
    expect(share).toHaveBeenCalledTimes(1);
    expect(share.mock.calls[0][0].files[0].name).toBe('new-download.md');
  });

  it('expires prepared bytes even after a different file fetch fails', async () => {
    vi.useFakeTimers();
    mockApiFetch.mockImplementation(async () => new Response('bytes'));
    const share = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('Gesture expired', 'NotAllowedError'))
      .mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true });
    Object.defineProperty(navigator, 'share', { value: share, configurable: true });
    await expect(shareFile('prepared.md')).rejects.toThrow('Tap Share again');
    mockApiFetch.mockRejectedValueOnce(new Error('Network unavailable'));
    await expect(shareFile('other.md')).rejects.toThrow('Network unavailable');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    const before = mockApiFetch.mock.calls.length;
    await shareFile('prepared.md');
    expect(mockApiFetch.mock.calls.length).toBe(before + 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports unsupported native sharing without pretending a blob download saved the file', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    Object.defineProperty(navigator, 'canShare', { value: () => false, configurable: true });
    mockApiFetch.mockImplementation(async () => new Response('bytes'));
    await expect(shareFile('unsupported.bin')).rejects.toThrow('cannot share this file type');
    expect(createObjectURLSpy).not.toHaveBeenCalled();
  });

  it.each([
    'This sandbox is stopped. Resume the conversation to access its files.',
    'This sandbox workspace is no longer available.',
  ])('preserves workspace guidance when downloading: %s', async (message) => {
    mockApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: message }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(shareFile('report.md', 'sandbox-session')).rejects.toThrow(message);
    expect(createObjectURLSpy).not.toHaveBeenCalled();
  });

  it('throws when server returns error', async () => {
    mockApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Path not allowed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(shareFile('/etc/passwd')).rejects.toThrow('Path not allowed');
  });

  it('returns false when the native share is cancelled', async () => {
    const blob = new Blob(['data'], { type: 'text/plain' });
    mockApiFetch.mockResolvedValue(new Response(blob, { status: 200 }));

    const abortError = new DOMException('Share canceled', 'AbortError');
    const shareFn = vi.fn().mockRejectedValue(abortError);
    Object.defineProperty(navigator, 'canShare', {
      value: () => true,
      configurable: true,
    });
    Object.defineProperty(navigator, 'share', {
      value: shareFn,
      configurable: true,
    });

    const result = await shareFile('/workspace/notes.txt');
    expect(result).toBe(false);
  });
});
