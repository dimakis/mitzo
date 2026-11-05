import { beforeEach, expect, it, vi } from 'vitest';
import { fetchPublicPage } from '../public-web-fetch.js';
import { executePublicGitHubRead } from '../public-github-read.js';

vi.mock('../public-web-fetch.js', () => ({ fetchPublicPage: vi.fn() }));

beforeEach(() => {
  vi.mocked(fetchPublicPage).mockReset().mockResolvedValue('public repository data');
});

it('uses the credential-free public fetcher and rechecks ownership at I/O and delivery', async () => {
  const current = vi.fn();
  vi.mocked(fetchPublicPage).mockImplementationOnce(async (_url, _signal, _deps, check) => {
    await check!();
    return 'public repository data';
  });
  const signal = new AbortController().signal;
  await expect(
    executePublicGitHubRead(
      '/repos/example/project/pulls?per_page=2',
      signal,
      undefined,
      undefined,
      'full',
      current,
    ),
  ).resolves.toBe('public repository data');
  expect(fetchPublicPage).toHaveBeenCalledWith(
    'https://api.github.com/repos/example/project/pulls?per_page=2',
    expect.any(AbortSignal),
    undefined,
    expect.any(Function),
    'full',
  );
  expect(current.mock.calls.length).toBeGreaterThanOrEqual(2);
});

it.each([
  '/user',
  '/search/issues?q=x',
  '//evil.test/repos/a/b',
  '/repos/a/b/../user',
  '/repos/a/b%2fissues',
])('rejects non-repository and ambiguous routes before network access: %s', async (endpoint) => {
  await expect(executePublicGitHubRead(endpoint, new AbortController().signal)).rejects.toThrow();
  expect(fetchPublicPage).not.toHaveBeenCalled();
});

it('reports public read failures without invoking an authenticated fallback', async () => {
  vi.mocked(fetchPublicPage).mockRejectedValueOnce(Error('HTTP 404'));
  await expect(
    executePublicGitHubRead('/repos/example/private', new AbortController().signal),
  ).rejects.toThrow(/public|404/i);
  expect(fetchPublicPage).toHaveBeenCalledTimes(1);
});

it('withholds a response if its runtime is revoked while the read is in flight', async () => {
  let revoked = false;
  vi.mocked(fetchPublicPage).mockImplementationOnce(async () => {
    revoked = true;
    return 'must not be delivered';
  });
  await expect(
    executePublicGitHubRead(
      '/repos/example/project',
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      () => {
        if (revoked) throw Error('Owner revoked');
      },
    ),
  ).rejects.toThrow('Owner revoked');
});

it('enforces the selected output bound after public response projection', async () => {
  vi.mocked(fetchPublicPage).mockResolvedValueOnce('x'.repeat(1025));
  await expect(
    executePublicGitHubRead(
      '/repos/example/project',
      new AbortController().signal,
      undefined,
      1024,
    ),
  ).rejects.toThrow(/narrower|limit|bound/i);
});
