import { beforeEach, expect, it, vi } from 'vitest';
const close = vi.hoisted(() => vi.fn());
vi.mock('node:fs', () => ({ closeSync: close }));
import { withAppleFile } from '../apple-private-file.js';
beforeEach(() => {
  close.mockReset();
});
it('closes the descriptor after a successful operation', () => {
  expect(withAppleFile(7, () => 'record')).toBe('record');
  expect(close).toHaveBeenCalledWith(7);
});
it('preserves the original operation error when cleanup succeeds', () => {
  const original = new Error('original');
  expect(() =>
    withAppleFile(7, () => {
      throw original;
    }),
  ).toThrow(original);
  expect(close).toHaveBeenCalledWith(7);
});
it('preserves both errors when cleanup also fails', () => {
  const original = new Error('original'),
    cleanup = new Error('cleanup');
  close.mockImplementation(() => {
    throw cleanup;
  });
  try {
    withAppleFile(7, () => {
      throw original;
    });
    throw new Error('Expected failure');
  } catch (result) {
    expect(result).toMatchObject({ cause: expect.any(AggregateError) });
    expect(((result as Error).cause as AggregateError).errors).toEqual([original, cleanup]);
  }
});
