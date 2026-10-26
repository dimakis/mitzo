import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthoritySnapshot } from '../sandbox-authority.js';
import * as sandbox from '../sandboxed-command.js';
import {
  privateRepositoryCheckoutAttributes,
  privateRepositoryCheckoutConfig,
} from '../private-repository-checkout.js';

let root: string, scratch: string, git: string, baseOid: string;
const environment = {
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'offline@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'offline@example.invalid',
};
const identity = async (path: string) => {
  const info = await lstat(path, { bigint: true });
  return { dev: String(info.dev), ino: String(info.ino) };
};
const execute = (args: string[], input?: string) =>
  execFileSync('/usr/bin/git', ['--git-dir', git, ...args], {
    encoding: 'utf8',
    env: environment,
    input,
  }).trim();
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'mitzo-private-checkout-')));
  scratch = join(root, 'owned');
  git = join(scratch, 'git-admin');
  await mkdir(scratch);
  execute(['init', '--bare', '-q', '--template=', git]);
  const blob = execute(['hash-object', '-w', '--stdin'], 'RAW $Id$\n');
  const attributes = execute(['hash-object', '-w', '--stdin'], '* text eol=crlf ident\n');
  const tree = execute(
    ['mktree'],
    `100644 blob ${blob}\tfile.txt\n100644 blob ${attributes}\t.gitattributes\n`,
  );
  baseOid = execute(['commit-tree', tree], 'fixture\n');
  await writeFile(join(git, 'config'), privateRepositoryCheckoutConfig('sha1'));
  await mkdir(join(git, 'info'), { recursive: true });
  await writeFile(join(git, 'info', 'attributes'), privateRepositoryCheckoutAttributes);
  await mkdir(join(scratch, 'checkout'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
async function options() {
  const retained = new AuthoritySnapshot();
  retained.capture(join(git, 'config'), true);
  retained.capture(join(git, 'info', 'attributes'), true);
  return {
    privateAuthority: retained
      .serialize()
      .filter((item) => item.path === scratch || item.path.startsWith(scratch + '/')),
    scratchAnchor: { rootPath: scratch, identity: await identity(scratch) },
    gitIdentity: await identity(git),
    stagingIdentity: await identity(join(scratch, 'checkout')),
    baseOid,
    objectFormat: 'sha1' as const,
    deniedRoots: [],
    signal: new AbortController().signal,
    timeoutMs: 15000,
    assertCurrentSync() {},
    async revalidate() {},
  };
}
const actual = it.runIf(
  process.platform === 'darwin' && process.env.MITZO_SANDBOX_INTEGRATION === '1',
);
actual(
  'checks out only fixed private Git bytes with raw attributes and no source/task path',
  async () => {
    await sandbox.executePrivateRepositoryStagingCheckout(await options());
    expect(await readFile(join(scratch, 'checkout', 'file.txt'), 'utf8')).toBe('RAW $Id$\n');
    expect(await readFile(join(git, 'index'))).toBeTruthy();
  },
  30000,
);
it('refuses replaced owned staging and executable config before launching', async () => {
  const input = await options();
  await rename(join(scratch, 'checkout'), join(scratch, 'retained'));
  await mkdir(join(scratch, 'checkout'));
  await expect(sandbox.executePrivateRepositoryStagingCheckout(input)).rejects.toThrow();
  const updated = await options();
  await writeFile(join(git, 'config'), '[include]\npath=/synthetic/never-read\n');
  await expect(sandbox.executePrivateRepositoryStagingCheckout(updated)).rejects.toThrow();
  await expect(lstat(join(git, 'index'))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('checks full original owner before any private setup and after joined failures', async () => {
  const input = await options(),
    error = Error('CURRENT OWNER REVOKED');
  const revalidate = vi.fn(async () => {
    throw error;
  });
  await expect(
    sandbox.executePrivateRepositoryStagingCheckout({ ...input, revalidate }),
  ).rejects.toThrow('CURRENT OWNER REVOKED');
  expect(revalidate).toHaveBeenCalledOnce();
  await expect(lstat(join(git, 'index'))).rejects.toMatchObject({ code: 'ENOENT' });
});
