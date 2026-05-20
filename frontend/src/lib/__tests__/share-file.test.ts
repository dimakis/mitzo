// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api-fetch', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '../api-fetch';
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
    createObjectURLSpy = vi.fn().mockReturnValue('blob:test-url') as unknown as ReturnType<typeof vi.spyOn>;
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
  });

  it('downloads file and triggers browser download when canShare is unavailable', async () => {
    const blob = new Blob(['# Hello'], { type: 'application/octet-stream' });
    mockApiFetch.mockResolvedValue(new Response(blob, { status: 200 }));

    // Ensure no native share
    Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true });

    const result = await shareFile('/workspace/report.md');

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/files/download?path=%2Fworkspace%2Freport.md',
    );
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

  it('throws when server returns error', async () => {
    mockApiFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Path not allowed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(shareFile('/etc/passwd')).rejects.toThrow('Path not allowed');
  });

  it('treats AbortError from share cancellation as success', async () => {
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
    expect(result).toBe(true);
  });
});
