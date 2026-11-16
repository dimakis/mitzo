import { afterEach, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freezeDenyOnlyReadPatterns } from '../repository-read-denials.js';
import { captureLocalRepositoryReader } from '../local-repository-native-reader.js';
import * as sandbox from '../sandboxed-command.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it('retains only qualified private-file family denials without broadening read access', () => {
  const input = ['/offline/.env.runtime-*', '/offline/.env.before-runtime-*'];
  const result = freezeDenyOnlyReadPatterns(input);
  expect(result).toEqual(input);
  input.splice(0);
  expect(result).toHaveLength(2);
  expect(() => (result as string[]).splice(0)).toThrow();
  for (const invalid of [
    ['/'],
    ['/offline/*'],
    ['relative/.env.runtime-*'],
    ['/offline/../.env.runtime-*'],
  ])
    expect(() => freezeDenyOnlyReadPatterns(invalid)).toThrow();
});

it.skipIf(process.platform !== 'darwin')(
  'enforces original private patterns before anchored reads and forwards them to the one helper sandbox',
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'repository-read-policy-')));
    roots.push(root);
    const source = join(root, 'source');
    const denied = join(root, '.env.runtime-private');
    await mkdir(source);
    await mkdir(denied);
    const execute = vi.spyOn(sandbox, 'executeSandboxedCommand').mockImplementation(async () => {
      const info = await lstat(source, { bigint: true });
      const content = JSON.stringify({
        rootPath: source,
        identity: { dev: String(info.dev), ino: String(info.ino) },
      });
      return {
        content: '',
        isError: false,
        stdout: `{"content": ${JSON.stringify(content)}, "is_error": false}\n`,
      };
    });
    const scope = Object.freeze({
      readableRoots: Object.freeze(['/']),
      workspaceRoots: Object.freeze([root]),
      deniedRoots: Object.freeze([]),
      deniedReadPatterns: Object.freeze([join(root, '.env.runtime-*')]),
    });
    const signal = new AbortController().signal;
    const reader = await captureLocalRepositoryReader(
      scope,
      signal,
      () => {},
      async () => {},
      { deadline: Date.now() + 30_000 },
    );
    try {
      await expect(reader.captureReadAnchor(denied)).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
      await reader.captureReadAnchor(source);
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0][0]).toMatchObject({
        deniedReadPatterns: scope.deniedReadPatterns,
        privateOutput: 'separate',
      });
    } finally {
      await reader.dispose();
    }
  },
);
