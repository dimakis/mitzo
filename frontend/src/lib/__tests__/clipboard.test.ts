// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { copyToClipboard } from '../clipboard';

describe('copyToClipboard', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn() },
    });
  });

  it('calls navigator.clipboard.writeText and returns true', async () => {
    (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const result = await copyToClipboard('hello');
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('hello');
    expect(result).toBe(true);
  });

  it('returns false when writeText rejects', async () => {
    (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('denied'),
    );
    const result = await copyToClipboard('hello');
    expect(result).toBe(false);
  });
});
