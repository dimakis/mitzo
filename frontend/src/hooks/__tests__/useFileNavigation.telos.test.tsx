// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
vi.mock('../../lib/api-fetch', () => ({ apiFetch: vi.fn() }));
vi.mock('../../lib/share-file', () => ({ fetchFile: vi.fn() }));
import { apiFetch } from '../../lib/api-fetch';
import { fetchFile } from '../../lib/share-file';
import { useFileNavigation } from '../useFileNavigation';
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const path = '/api/telos/artifacts/' + 'a'.repeat(32) + '?revision=2';
describe('durable Telos file viewing', () => {
  it.each([
    ['Brief.md', 'text/markdown', '# Stored brief', '.md', true],
    [
      'Résumé.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '',
      '.docx',
      false,
    ],
  ] as const)(
    'opens %s with the original identity, without looking in a workspace',
    async (name, type, content, ext, text) => {
      const readText = vi.fn().mockResolvedValue(content);
      vi.mocked(fetchFile).mockResolvedValue({ name, type, text: readText } as unknown as File);
      const { result } = renderHook(() =>
        useFileNavigation(new URLSearchParams({ path }), vi.fn()),
      );
      await waitFor(() => expect(result.current.state.loading).toBe(false));
      expect(fetchFile).toHaveBeenCalledExactlyOnceWith(path);
      expect(apiFetch).not.toHaveBeenCalled();
      expect(result.current.state.filePath).toBe(path);
      expect(result.current.state.displayName).toBe(name);
      expect(result.current.state.ext).toBe(ext);
      if (text) expect(result.current.state.content).toBe(content);
      else {
        expect(readText).not.toHaveBeenCalled();
        expect(result.current.state.content).toContain('no in-app preview');
      }
    },
  );
});
