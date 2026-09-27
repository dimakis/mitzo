import { describe, expect, it, vi } from 'vitest';
import { CredentialResolver } from '../credentials.js';
import {
  PublicationCredentialCustodian,
  type PublicationCommandRunner,
} from '../symposium-publication-credentials.js';
const reference = { provider: 'test', service: 'github', account: 'operator' };
describe('publication credential custody', () => {
  it('lists metadata without resolving and binds an immutable selected generation', async () => {
    const resolve = vi.fn(async () => 'selected-secret');
    const run = vi.fn<PublicationCommandRunner>(async () => ({ stdout: 'ok' }));
    const custody = new PublicationCredentialCustodian(
      new CredentialResolver({ test: { resolve } }),
      run,
    );
    custody.register('write', 'GitHub operator', reference);
    expect(custody.list()).toEqual([
      { id: 'write', label: 'GitHub operator', revision: 1, selected: false },
    ]);
    expect(resolve).not.toHaveBeenCalled();
    const handle = await custody.select('write', 1);
    expect(await handle.run('gh', ['api', '/user'], new AbortController().signal)).toEqual({
      stdout: 'ok',
    });
    expect(run.mock.calls[0][3].GH_TOKEN).toBe('selected-secret');
    expect(run.mock.calls[0][3].GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(custody.resolve('write', 1, handle.generation)).toBe(handle);
    custody.disconnect('write', 1);
    expect(() => handle.assertCurrent()).toThrow();
  });
  it('refuses out-of-band replacement before dispatch without switching credentials', async () => {
    let secret = 'original';
    const run = vi.fn<PublicationCommandRunner>(async () => ({ stdout: 'ok' }));
    const custody = new PublicationCredentialCustodian(
      new CredentialResolver({ test: { resolve: async () => secret } }),
      run,
    );
    custody.register('write', 'GitHub operator', reference);
    const handle = await custody.select('write', 1);
    secret = 'replacement';
    await expect(handle.run('gh', ['api', '/user'], new AbortController().signal)).rejects.toThrow(
      'credential',
    );
    expect(run).not.toHaveBeenCalled();
    expect(() => handle.assertCurrent()).toThrow();
  });
  it('cancels in-flight commands on disconnect and never exposes secret errors', async () => {
    let started!: () => void;
    const dispatched = new Promise<void>((r) => {
      started = r;
    });
    const custody = new PublicationCredentialCustodian(
      new CredentialResolver({ test: { resolve: async () => 'private-secret' } }),
      async (_command, _args, signal) => {
        started();
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('private-secret'))),
        );
        return { stdout: '' };
      },
    );
    custody.register('write', 'GitHub operator', reference);
    const handle = await custody.select('write', 1);
    const pending = handle.run('gh', ['api', '/user'], new AbortController().signal);
    await dispatched;
    custody.disconnect('write', 1);
    await expect(pending).rejects.toThrow('Publication credential command failed');
  });
});
