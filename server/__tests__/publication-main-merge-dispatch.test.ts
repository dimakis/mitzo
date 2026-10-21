import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { stat, rm } from 'node:fs/promises';
import { CredentialResolver } from '../credentials.js';
import {
  PublicationCredentialCustodian,
  type PublicationCommandRunner,
} from '../symposium-publication-credentials.js';

// External process/provider responses and the optional cleanup I/O failure are
// controlled. Custody, resolver, immutable selection, default isolated runner,
// real temporary-directory creation and ordinary cleanup remain original.
const boundary = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; cwd: string; env: NodeJS.ProcessEnv }>,
  afterReply: undefined as (() => void) | undefined,
  cleanup: undefined as (() => void | Promise<void>) | undefined,
  stdout: undefined as string | undefined,
  rejectProcess: false,
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    rm: async (...args: Parameters<typeof fs.rm>) => {
      await boundary.cleanup?.();
      return fs.rm(...args);
    },
  };
});
vi.mock('node:child_process', () => {
  const execute = async (
    command: string,
    _args: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ) => {
    boundary.calls.push({ command, cwd: options.cwd, env: options.env });
    const result = { stdout: boundary.stdout ?? '{"merged":true}', stderr: '' };
    if (boundary.rejectProcess) throw Object.assign(Error('Process failed'), result);
    boundary.afterReply?.();
    return result;
  };
  return {
    execFile: Object.assign(
      () => {
        throw Error('Only the promisified process boundary is expected');
      },
      {
        [Symbol.for('nodejs.util.promisify.custom')]: execute,
      },
    ),
  };
});

const reference = { provider: 'test', service: 'github', account: 'merge-operator' };
async function selected(runner?: PublicationCommandRunner) {
  const owner = new PublicationCredentialCustodian(
    new CredentialResolver({ test: { resolve: async () => 'offline-selected-secret' } }),
    runner,
  );
  owner.register('main-merge', 'Explicit main merge connection', reference);
  return { owner, handle: await owner.select('main-merge', 1) };
}
const args = ['api', 'graphql', '-f', 'query=synthetic-external-mutation'];
beforeEach(() => {
  boundary.calls.length = 0;
  boundary.afterReply = undefined;
  boundary.cleanup = undefined;
  boundary.stdout = undefined;
  boundary.rejectProcess = false;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

it('rechecks authority after actual asynchronous command preparation and refuses before the process effect', async () => {
  const { owner, handle } = await selected();
  let current = true;
  let admitted = 0;
  const pending = owner.dispatchMainMerge(handle, args, new AbortController().signal, () => {
    if (!current) throw Error('Native/work authority changed during preparation');
    admitted++;
  });
  current = false;
  await expect(pending).rejects.toThrow();
  expect(admitted).toBe(0);
  expect(boundary.calls).toEqual([]);
});

it('dispatches once with the selected credential and prepared isolated directory after admission', async () => {
  vi.stubEnv('GH_TOKEN', 'unrelated-ambient-token');
  const { owner, handle } = await selected();
  let admitted = 0;
  const result = await owner.dispatchMainMerge(handle, args, new AbortController().signal, () => {
    expect(boundary.calls).toEqual([]);
    handle.assertCurrent();
    admitted++;
  });
  expect(result).toEqual({ stdout: '{"merged":true}' });
  expect(admitted).toBe(1);
  expect(boundary.calls).toHaveLength(1);
  const call = boundary.calls[0];
  expect(call.command).toBe('gh');
  expect(call.cwd).not.toBe(process.cwd());
  expect(call.env.HOME).toBe(call.cwd);
  expect(call.env.GH_CONFIG_DIR).toBe(call.cwd);
  expect(call.env.GH_TOKEN).toBe('offline-selected-secret');
  await expect(stat(call.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('never dispatches when the original admission callback throws', async () => {
  const { owner, handle } = await selected();
  await expect(
    owner.dispatchMainMerge(handle, args, new AbortController().signal, () => {
      throw Error('Original permission or publication hold refused');
    }),
  ).rejects.toThrow();
  expect(boundary.calls).toEqual([]);
});

it('refuses a copied or foreign handle before permission or dispatch', async () => {
  const { owner, handle } = await selected();
  const other = await selected();
  const admit = vi.fn();
  for (const candidate of [{ ...handle }, other.handle])
    await expect(
      owner.dispatchMainMerge(candidate, args, new AbortController().signal, admit),
    ).rejects.toThrow();
  expect(admit).not.toHaveBeenCalled();
  expect(boundary.calls).toEqual([]);
});

it('refuses disconnection during asynchronous preparation without admitting or switching credentials', async () => {
  const { owner, handle } = await selected();
  const admit = vi.fn();
  const pending = owner.dispatchMainMerge(handle, args, new AbortController().signal, admit);
  owner.disconnect(handle.connectionId, handle.revision);
  await expect(pending).rejects.toThrow();
  expect(admit).not.toHaveBeenCalled();
  expect(boundary.calls).toEqual([]);
});

it('renews the same credential after directory preparation and refuses replacement before admission', async () => {
  let reads = 0;
  const owner = new PublicationCredentialCustodian(
    new CredentialResolver({
      test: {
        resolve: async () => (++reads < 3 ? 'original-offline-secret' : 'replacement-secret'),
      },
    }),
  );
  owner.register('main-merge', 'Explicit main merge connection', reference);
  const handle = await owner.select('main-merge', 1);
  const admit = vi.fn();
  await expect(
    owner.dispatchMainMerge(handle, args, new AbortController().signal, admit),
  ).rejects.toThrow();
  expect(reads).toBe(3);
  expect(admit).not.toHaveBeenCalled();
  expect(boundary.calls).toEqual([]);
  expect(() => handle.assertCurrent()).toThrow();
});

it('honours original native cancellation before admission and dispatch', async () => {
  const { owner, handle } = await selected();
  const controller = new AbortController();
  const admit = vi.fn();
  const pending = owner.dispatchMainMerge(handle, args, controller.signal, admit);
  controller.abort();
  await expect(pending).rejects.toThrow();
  expect(admit).not.toHaveBeenCalled();
  expect(boundary.calls).toEqual([]);
});

it('rejects an executor that reports success without running the required dispatch callback', async () => {
  const { owner, handle } = await selected(async () => ({ stdout: 'reported-success' }));
  const admit = vi.fn();
  await expect(
    owner.dispatchMainMerge(handle, args, new AbortController().signal, admit),
  ).rejects.toThrow();
  expect(admit).not.toHaveBeenCalled();
});

it('calls original admission at most once if an executor invokes the dispatch boundary twice', async () => {
  const { owner, handle } = await selected(async (_command, _args, _signal, _env, prepare) => {
    const dispatch = await prepare!();
    dispatch();
    dispatch();
    return { stdout: 'unexpected' };
  });
  const admit = vi.fn();
  await expect(
    owner.dispatchMainMerge(handle, args, new AbortController().signal, admit),
  ).rejects.toThrow();
  expect(admit).toHaveBeenCalledTimes(1);
});

it('retains a successful mutation response after external credential replacement and refuses fresh reads', async () => {
  let secret = 'original-offline-secret';
  let reads = 0;
  const owner = new PublicationCredentialCustodian(
    new CredentialResolver({
      test: {
        resolve: async () => {
          reads++;
          return secret;
        },
      },
    }),
  );
  owner.register('main-merge', 'Explicit main merge connection', reference);
  const handle = await owner.select('main-merge', 1);
  boundary.afterReply = () => {
    secret = 'replaced-after-received-response';
  };
  const admit = vi.fn();
  const response = await owner.dispatchMainMerge(handle, args, new AbortController().signal, admit);
  expect(response).toEqual({ stdout: '{"merged":true}' });
  expect(reads).toBe(3); // Selection, preflight and final post-cwd verification.
  expect(admit).toHaveBeenCalledTimes(1);
  expect(boundary.calls).toHaveLength(1);
  await expect(handle.run('gh', ['api', 'user'], new AbortController().signal)).rejects.toThrow();
  expect(() => handle.assertCurrent()).toThrow();
  expect(boundary.calls).toHaveLength(1);
});

it.each(['native-abort', 'disconnect', 'disconnect-during-cleanup'] as const)(
  'retains actual successful mutation stdout despite later %s without restoring effect authority',
  async (change) => {
    const { owner, handle } = await selected();
    const controller = new AbortController();
    const revoke = () => {
      if (change === 'native-abort') controller.abort();
      else owner.disconnect(handle.connectionId, handle.revision);
    };
    if (change === 'disconnect-during-cleanup') boundary.cleanup = revoke;
    else boundary.afterReply = revoke;
    const admit = vi.fn();
    const result = await owner.dispatchMainMerge(handle, args, controller.signal, admit);
    expect(result).toEqual({ stdout: '{"merged":true}' });
    expect(admit).toHaveBeenCalledTimes(1);
    expect(boundary.calls).toHaveLength(1);
    boundary.cleanup = undefined;
    await expect(owner.dispatchMainMerge(handle, args, controller.signal, admit)).rejects.toThrow();
    expect(admit).toHaveBeenCalledTimes(1);
    expect(boundary.calls).toHaveLength(1);
    await expect(stat(boundary.calls[0].cwd)).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

it('retains received mutation stdout when isolated directory cleanup fails', async () => {
  const { owner, handle } = await selected();
  const admit = vi.fn();
  boundary.cleanup = () => {
    throw Error('Controlled external cleanup failure');
  };
  try {
    const result = await owner.dispatchMainMerge(handle, args, new AbortController().signal, admit);
    expect(result).toEqual({ stdout: '{"merged":true}' });
    expect(admit).toHaveBeenCalledTimes(1);
    expect(boundary.calls).toHaveLength(1);
  } finally {
    boundary.cleanup = undefined;
    for (const call of boundary.calls) await rm(call.cwd, { recursive: true, force: true });
  }
});

it('preserves the ordinary read post-response credential verification', async () => {
  let secret = 'original-offline-secret';
  const owner = new PublicationCredentialCustodian(
    new CredentialResolver({ test: { resolve: async () => secret } }),
  );
  owner.register('main-merge', 'Explicit main merge connection', reference);
  const handle = await owner.select('main-merge', 1);
  boundary.afterReply = () => {
    secret = 'replaced-after-read-response';
  };
  await expect(handle.run('gh', ['api', 'user'], new AbortController().signal)).rejects.toThrow();
  expect(boundary.calls).toHaveLength(1);
  expect(() => handle.assertCurrent()).toThrow();
});

it('does not manufacture a received response from a rejected process carrying stdout', async () => {
  const { owner, handle } = await selected();
  boundary.rejectProcess = true;
  const admit = vi.fn();
  await expect(
    owner.dispatchMainMerge(handle, args, new AbortController().signal, admit),
  ).rejects.toThrow();
  expect(admit).toHaveBeenCalledTimes(1);
  expect(boundary.calls).toHaveLength(1);
});

it.each(['secret', 'oversize'] as const)(
  'still refuses %s in a resolved mutation response',
  async (invalid) => {
    const { owner, handle } = await selected();
    boundary.stdout =
      invalid === 'secret' ? 'offline-selected-secret' : 'x'.repeat(4 * 1024 * 1024 + 1);
    const admit = vi.fn();
    await expect(
      owner.dispatchMainMerge(handle, args, new AbortController().signal, admit),
    ).rejects.toThrow();
    expect(admit).toHaveBeenCalledTimes(1);
    expect(boundary.calls).toHaveLength(1);
  },
);
