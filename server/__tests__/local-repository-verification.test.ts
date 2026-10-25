import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRepositoryReadAccess } from '../local-repository-read-access.js';
import { executeNativeAnchoredReadOperation } from '../native-file-operation.js';
import { fixtureReadAnchor } from './fixtures/local-repository-read-owner.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

it.each([false, true])(
  'joins original witnesses before returning with at most two transports (failure=%s)',
  async (failure) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-verify-read-')));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const one = join(root, 'one'),
      two = join(root, 'two');
    await mkdir(one);
    await mkdir(two);
    let verifying = false,
      active = 0,
      maximum = 0;
    const finished: string[] = [];
    const access = new LocalRepositoryReadAccess({
      deniedRoots: [],
      captureReadAnchor: fixtureReadAnchor,
      assertReadable: async () => {},
      deadline: Date.now() + 15000,
      executeReadOperation: async (...args) => {
        if (!verifying) return executeNativeAnchoredReadOperation(...args);
        active++;
        maximum = Math.max(maximum, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (failure && args[0].file_path === root) throw Error('Fixture witness unavailable');
          return await executeNativeAnchoredReadOperation(...args);
        } finally {
          finished.push(args[0].file_path);
          active--;
        }
      },
    });
    await access.pinRoot(root);
    for (const directory of [root, one, two]) await access.list(directory);
    verifying = true;
    if (failure) await expect(access.verify()).rejects.toThrow('Fixture witness unavailable');
    else await access.verify();
    expect(maximum).toBe(2);
    expect(active).toBe(0);
    expect(finished.sort()).toEqual((failure ? [root, one] : [root, one, two]).sort());
  },
  20000,
);
