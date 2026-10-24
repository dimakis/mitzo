import { expect, it, vi } from 'vitest';
import {
  LocalRepositoryReadAccess,
  type LocalRepositoryReadAuthority,
  type LocalRepositoryReadCeiling,
} from '../local-repository-read-access.js';

const root = '/fixture/root';
const second = '/fixture/second';
const file = `${root}/source.txt`;
const identity = Object.freeze({ dev: '1', ino: '2' });
function fixture() {
  const calls: string[] = [];
  let current = true;
  const assertCurrentSync = vi.fn(() => {
    if (!current) throw Error('Original source owner revoked');
  });
  const listing = {
    content: JSON.stringify({
      identity,
      truncated: false,
      incomplete: false,
      entries: [
        {
          name: 'source.txt',
          identity: { dev: '1', ino: '3' },
          kind: 'file',
          size: 4,
          mode: 0o100600,
          nlink: 1,
          mtimeNs: '1',
          ctimeNs: '1',
        },
      ],
    }),
    is_error: false,
  };
  const authority: LocalRepositoryReadAuthority = {
    deniedRoots: [],
    deadline: Date.now() + 15000,
    assertReadable: vi.fn(async (path) => {
      assertCurrentSync();
      calls.push(`owner:${path}`);
    }),
    captureReadAnchor: vi.fn(async (path) => ({ rootPath: path, identity })),
    executeReadOperation: vi.fn(async (request) =>
      request.operation === 'ReadBytes'
        ? { content: Buffer.from('DATA').toString('base64'), is_error: false }
        : listing,
    ),
    executeDirectoryVerification: vi.fn(async (requests) => requests.map(() => listing)),
    revalidate: vi.fn(async () => {
      assertCurrentSync();
      calls.push('owner:final');
    }),
  };
  Object.defineProperty(authority, 'assertCurrentSync', { value: assertCurrentSync });
  const ceiling: LocalRepositoryReadCeiling = {
    assertReadable: vi.fn(async (path) => {
      calls.push(`ceiling:${path}`);
    }),
    revalidate: vi.fn(async () => {
      calls.push('ceiling:final');
    }),
  };
  return {
    calls,
    authority,
    ceiling,
    assertCurrentSync,
    revoke: () => {
      current = false;
    },
  };
}

it.each(['missing', 'null', 'inherited', 'accessor'] as const)(
  'refuses a ceiling without the original own data sync owner port (%s)',
  (kind) => {
    const f = fixture();
    const getter = vi.fn(() => f.assertCurrentSync);
    const authority = { ...f.authority };
    if (kind === 'null') Object.defineProperty(authority, 'assertCurrentSync', { value: null });
    if (kind === 'accessor') Object.defineProperty(authority, 'assertCurrentSync', { get: getter });
    if (kind === 'inherited')
      Object.setPrototypeOf(authority, { assertCurrentSync: f.assertCurrentSync });
    expect(() => new LocalRepositoryReadAccess(authority, f.ceiling)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(f.authority.captureReadAnchor).not.toHaveBeenCalled();
    expect(f.authority.assertReadable).not.toHaveBeenCalled();
  },
);

it.each(['logical', 'cached', 'final'] as const)(
  'refuses original source revocation during the last ceiling await (%s)',
  async (phase) => {
    const f = fixture();
    let armed = false;
    let validations = 0;
    const revoke = async () => {
      await Promise.resolve();
      // Refuse drift after the LAST ceiling validation, not just a drift
      // already detected by the intervening actual owner async validation.
      if (armed && (phase === 'final' || ++validations === 2)) f.revoke();
    };
    f.ceiling.assertReadable = revoke;
    if (phase === 'final') f.ceiling.revalidate = revoke;
    const access = new LocalRepositoryReadAccess(f.authority, f.ceiling);
    if (phase === 'cached') {
      await access.pinRoot(root);
      await access.list(root);
    }
    armed = true;
    validations = 0;
    const result =
      phase === 'final'
        ? access.verify()
        : phase === 'cached'
          ? access.stat(file)
          : access.assertPath(root);
    await expect(result).rejects.toMatchObject({ kind: 'access' });
    if (phase === 'final') expect(f.authority.revalidate).toHaveBeenCalledOnce();
  },
);

it.each([false, Promise.resolve(undefined)])(
  'refuses non-undefined original synchronous owner results after a ceiling wait (%s)',
  async (result) => {
    const f = fixture();
    const authority = { ...f.authority };
    Object.defineProperty(authority, 'assertCurrentSync', { value: () => result });
    const access = new LocalRepositoryReadAccess(authority, f.ceiling);
    await expect(access.assertPath(root)).rejects.toMatchObject({ kind: 'access' });
    expect(f.authority.captureReadAnchor).not.toHaveBeenCalled();
  },
);

it('retains the original sync callback receiver and runs it after the final awaited ceiling', async () => {
  const f = fixture();
  const authority = { ...f.authority };
  Object.defineProperty(authority, 'assertCurrentSync', {
    value: function () {
      expect(this).toBe(authority);
      f.calls.push('owner:sync');
    },
  });
  const access = new LocalRepositoryReadAccess(authority, f.ceiling);
  await access.verify();
  expect(f.calls.slice(-3)).toEqual(['owner:final', 'ceiling:final', 'owner:sync']);
});

it('cannot replace the captured original fence through its mutable own call property', async () => {
  const f = fixture();
  f.ceiling.revalidate = async () => {
    await Promise.resolve();
    Object.defineProperty(f.assertCurrentSync, 'call', { value: () => undefined });
    f.revoke();
  };
  const access = new LocalRepositoryReadAccess(f.authority, f.ceiling);
  await expect(access.verify()).rejects.toMatchObject({ kind: 'access' });
});

it.each(['assertReadable', 'revalidate'] as const)(
  'cannot replace the captured ceiling %s through its mutable own call property',
  async (method) => {
    const f = fixture();
    const deny = async () => {
      throw Error('Original ceiling denied');
    };
    f.ceiling[method] = deny;
    const access = new LocalRepositoryReadAccess(f.authority, f.ceiling);
    Object.defineProperty(deny, 'call', { value: async () => undefined });
    await expect(
      method === 'assertReadable' ? access.assertPath(root) : access.verify(),
    ).rejects.toMatchObject({ kind: 'access' });
  },
);

it.each([null, {}, [], { assertReadable: false, revalidate: async () => {} }])(
  'refuses a present malformed ceiling before any lookup (%j)',
  (ceiling) => {
    const f = fixture();
    expect(
      () =>
        new LocalRepositoryReadAccess(
          f.authority,
          ceiling as unknown as LocalRepositoryReadCeiling,
        ),
    ).toThrow();
    expect(f.authority.assertReadable).not.toHaveBeenCalled();
    expect(f.authority.captureReadAnchor).not.toHaveBeenCalled();
  },
);

it('refuses accessor and inherited ceiling callbacks without invoking getters', () => {
  const f = fixture();
  const getter = vi.fn(() => f.ceiling.assertReadable);
  const accessor = Object.defineProperty({ revalidate: f.ceiling.revalidate }, 'assertReadable', {
    get: getter,
  });
  expect(
    () => new LocalRepositoryReadAccess(f.authority, accessor as LocalRepositoryReadCeiling),
  ).toThrow();
  const inherited = Object.create(f.ceiling) as LocalRepositoryReadCeiling;
  expect(() => new LocalRepositoryReadAccess(f.authority, inherited)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(f.authority.captureReadAnchor).not.toHaveBeenCalled();
});

it('applies the additional ceiling before and after the actual owner with the original receiver', async () => {
  const f = fixture();
  const ceiling: LocalRepositoryReadCeiling = {
    async assertReadable(path) {
      expect(this).toBe(ceiling);
      f.calls.push(`ceiling:${path}`);
    },
    async revalidate() {
      expect(this).toBe(ceiling);
      f.calls.push('ceiling:final');
    },
  };
  const access = new LocalRepositoryReadAccess(f.authority, ceiling);
  // Mutation of a caller's method property cannot replace retained authority.
  ceiling.assertReadable = async () => {
    throw Error('Replacement must not run');
  };
  await access.assertPath(root);
  expect(f.calls).toEqual([`ceiling:${root}`, `owner:${root}`, `ceiling:${root}`]);
  f.calls.length = 0;
  await access.verify();
  expect(f.calls).toEqual(['owner:final', 'ceiling:final']);
});

it('refuses an additional denial before original-owner lookup or transport', async () => {
  const f = fixture();
  f.ceiling.assertReadable = vi.fn(async () => {
    throw Error('Do not expose private denial details');
  });
  const access = new LocalRepositoryReadAccess(f.authority, f.ceiling);
  await expect(access.pinRoot(root)).rejects.toMatchObject({ kind: 'access' });
  expect(f.authority.assertReadable).not.toHaveBeenCalled();
  expect(f.authority.captureReadAnchor).not.toHaveBeenCalled();
  expect(f.authority.executeReadOperation).not.toHaveBeenCalled();
});

it('rechecks the ceiling after an awaited owner validation before capturing identity', async () => {
  const f = fixture();
  let allowed = true;
  f.ceiling.assertReadable = vi.fn(async () => {
    if (!allowed) throw Error('Ceiling revoked');
  });
  f.authority.assertReadable = vi.fn(async () => {
    await Promise.resolve();
    allowed = false;
  });
  const access = new LocalRepositoryReadAccess(f.authority, f.ceiling);
  await expect(access.pinRoot(root)).rejects.toMatchObject({ kind: 'access' });
  expect(f.authority.captureReadAnchor).not.toHaveBeenCalled();
});

it.each(['stat', 'bytes', 'listing', 'batch'] as const)(
  'enforces the additional ceiling on cached %s and verification paths',
  async (operation) => {
    const f = fixture();
    let allowed = true;
    f.ceiling.assertReadable = vi.fn(async () => {
      if (!allowed) throw Error('Ceiling revoked');
    });
    const access = new LocalRepositoryReadAccess(f.authority, f.ceiling);
    await access.pinRoot(root);
    await access.pinRoot(second);
    if (operation === 'batch') await access.listPinnedRoots([root, second]);
    else {
      await access.list(root);
      if (operation === 'bytes') expect((await access.read(file, 4)).toString()).toBe('DATA');
    }
    vi.mocked(f.authority.executeReadOperation!).mockClear();
    vi.mocked(f.authority.executeDirectoryVerification!).mockClear();
    allowed = false;
    const attempt =
      operation === 'stat'
        ? access.stat(file)
        : operation === 'bytes'
          ? access.read(file, 4)
          : operation === 'listing'
            ? access.list(root)
            : access.verify();
    await expect(attempt).rejects.toMatchObject({ kind: 'access' });
    expect(f.authority.executeReadOperation).not.toHaveBeenCalled();
    expect(f.authority.executeDirectoryVerification).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  'revalidates the ceiling after the full owner on final verification (cached=%s)',
  async (cached) => {
    const f = fixture();
    let allowed = true;
    f.authority.revalidate = vi.fn(async () => {
      f.calls.push('owner:final');
      await Promise.resolve();
      allowed = false;
    });
    f.ceiling.revalidate = vi.fn(async () => {
      f.calls.push('ceiling:final');
      if (!allowed) throw Error('Ceiling revoked during owner validation');
    });
    const access = new LocalRepositoryReadAccess(f.authority, f.ceiling);
    if (cached) {
      await access.pinRoot(root);
      await access.list(root);
    }
    await expect(access.verify()).rejects.toMatchObject({ kind: 'access' });
    expect(f.calls.slice(-2)).toEqual(['owner:final', 'ceiling:final']);
  },
);

it.each(['assertReadable', 'revalidate'] as const)(
  'refuses a ceiling %s callback resolving a non-undefined value',
  async (method) => {
    const f = fixture();
    const callback = vi.fn(async () => false);
    const ceiling = { ...f.ceiling, [method]: callback } as unknown as LocalRepositoryReadCeiling;
    const access = new LocalRepositoryReadAccess(f.authority, ceiling);
    const attempt = method === 'assertReadable' ? access.assertPath(root) : access.verify();
    await expect(attempt).rejects.toMatchObject({ kind: 'access' });
    expect(callback).toHaveBeenCalledOnce();
  },
);

it('preserves the existing reader and full-owner verification when no additional ceiling is supplied', async () => {
  const f = fixture();
  const access = new LocalRepositoryReadAccess(f.authority);
  await access.pinRoot(root);
  await access.list(root);
  expect((await access.read(file, 4)).toString()).toBe('DATA');
  await access.verify();
  expect(f.authority.revalidate).toHaveBeenCalledOnce();
  expect(f.ceiling.assertReadable).not.toHaveBeenCalled();
});
