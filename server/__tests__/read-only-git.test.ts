import { expect, it, vi } from 'vitest';
import { createAsyncReadOnlyGitResolver, createReadOnlyGitResolver } from '../read-only-git.js';

it('resolves the macOS developer Git asynchronously once per burst, sharing concurrent lookups', async () => {
  const lookup = vi.fn(async () => '/selected/developer/usr/bin/git\n');
  let now = 0;
  const resolve = createAsyncReadOnlyGitResolver('darwin', lookup, () => now);
  expect(await Promise.all([resolve(), resolve()])).toEqual([
    '/selected/developer/usr/bin/git',
    '/selected/developer/usr/bin/git',
  ]);
  expect(await resolve()).toBe('/selected/developer/usr/bin/git');
  expect(lookup).toHaveBeenCalledTimes(1);
  now = 30_001;
  lookup.mockResolvedValue('/updated/developer/usr/bin/git');
  expect(await resolve()).toBe('/updated/developer/usr/bin/git');
  expect(lookup).toHaveBeenCalledTimes(2);
});

it('keeps normal async Git discovery outside macOS, for invalid paths and when lookup fails', async () => {
  const failing = vi.fn(async () => {
    throw Error('unavailable');
  });
  expect(await createAsyncReadOnlyGitResolver('linux', failing)()).toBe('git');
  expect(failing).not.toHaveBeenCalled();
  expect(await createAsyncReadOnlyGitResolver('darwin', failing)()).toBe('git');
  expect(await createAsyncReadOnlyGitResolver('darwin', async () => 'relative/git')()).toBe('git');
});

it('resolves the macOS developer shim once for a bounded burst of Git checks', () => {
  const lookup = vi.fn(() => '/selected/developer/usr/bin/git\n');
  let now = 0;
  const resolve = createReadOnlyGitResolver('darwin', lookup, () => now);
  expect(resolve()).toBe('/selected/developer/usr/bin/git');
  expect(resolve()).toBe('/selected/developer/usr/bin/git');
  expect(lookup).toHaveBeenCalledTimes(1);
  now = 30_001;
  lookup.mockReturnValue('/updated/developer/usr/bin/git');
  expect(resolve()).toBe('/updated/developer/usr/bin/git');
  expect(lookup).toHaveBeenCalledTimes(2);
});

it.each(['relative/git', '', '/selected/not-git'])(
  'keeps normal Git discovery when developer lookup returns %j',
  (path) => {
    expect(createReadOnlyGitResolver('darwin', () => path)()).toBe('git');
  },
);

it('preserves normal Git discovery outside macOS and when developer tools are unavailable', () => {
  const lookup = vi.fn(() => {
    throw Error('unavailable');
  });
  expect(createReadOnlyGitResolver('linux', lookup)()).toBe('git');
  expect(lookup).not.toHaveBeenCalled();
  expect(createReadOnlyGitResolver('darwin', lookup)()).toBe('git');
});
