// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
const { share } = vi.hoisted(() => ({ share: vi.fn() }));
vi.mock('@capacitor/core', () => ({ registerPlugin: () => ({ share }) }));
import { shareNativeFile } from '../native-file-share';

describe('native file share', () => {
  it('passes original binary bytes and filename, never a web URL or text payload', async () => {
    share.mockResolvedValueOnce({ completed: true });
    const file = new File([new Uint8Array([0, 255, 128, 65])], 'Résumé.docx');
    expect(await shareNativeFile(file)).toBe(true);
    expect(share).toHaveBeenLastCalledWith({ filename: 'Résumé.docx', base64: 'AP+AQQ==' });
  });
  it('reports cancellation and propagates errors', async () => {
    share.mockResolvedValueOnce({ completed: false });
    expect(await shareNativeFile(new File([''], 'empty.txt'))).toBe(false);
    share.mockRejectedValueOnce(new Error('Share unavailable'));
    await expect(shareNativeFile(new File(['x'], 'note.md'))).rejects.toThrow('Share unavailable');
  });
});
