import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  renameSync,
  symlinkSync,
  linkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  captureLocalArtifactFile,
  type ArtifactCommandRunner,
} from '../openshell-artifact-reader.js';

const roots: string[] = [];
function workspace() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'local-file-witness-')));
  roots.push(root);
  mkdirSync(join(root, 'outputs'));
  writeFileSync(join(root, 'outputs/a.md'), 'Exact output');
  return root;
}
afterEach(() => {
  roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }));
  vi.restoreAllMocks();
});
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

it('captures exact bytes/path/hash and a synchronous private witness using the existing file owner', async () => {
  const root = workspace();
  const guard = vi.fn(() => {});
  const file = await captureLocalArtifactFile(root, 'outputs/a.md', guard);
  expect(file.path).toBe(join(root, 'outputs/a.md'));
  expect(file.bytes.toString()).toBe('Exact output');
  expect(file.sha256).toBe(hash('Exact output'));
  expect(Object.isFrozen(file)).toBe(true);
  expect(() => file.assertCurrentSync()).not.toThrow();
  const calls = guard.mock.calls.length;
  file.assertCurrentSync();
  expect(guard.mock.calls).toHaveLength(calls); // Final custody renewal has no authority callback.
});

it.each(['bytes', 'replacement', 'root', 'hardlink', 'symlink'] as const)(
  'refuses %s replacement across approval waits',
  async (kind) => {
    const root = workspace();
    const path = join(root, 'outputs/a.md');
    const file = await captureLocalArtifactFile(root, path, () => {});
    if (kind === 'bytes') writeFileSync(path, 'XXXXXXXXXXXX');
    if (kind === 'replacement') {
      writeFileSync(join(root, 'next.md'), 'Exact output');
      renameSync(join(root, 'next.md'), path);
    }
    if (kind === 'root') {
      const moved = root + '-moved';
      roots.push(moved);
      renameSync(root, moved);
      mkdirSync(root);
      mkdirSync(join(root, 'outputs'));
      writeFileSync(path, 'Exact output');
    }
    if (kind === 'hardlink') linkSync(path, join(root, 'alias.md'));
    if (kind === 'symlink') {
      renameSync(path, join(root, 'elsewhere.md'));
      symlinkSync('elsewhere.md', path);
    }
    expect(() => file.assertCurrentSync()).toThrow();
  },
);

it('refuses caller mutation of the detached byte projection', async () => {
  const root = workspace();
  const file = await captureLocalArtifactFile(root, 'outputs/a.md', () => {});
  file.bytes.fill(33);
  expect(() => file.assertCurrentSync()).toThrow();
});

it('refuses account/root revocation during the asynchronous file read', async () => {
  const root = workspace();
  let current = true;
  const run: ArtifactCommandRunner = async (command, args) => {
    const stdout = execFileSync(command, [...args], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    current = false;
    return stdout;
  };
  await expect(
    captureLocalArtifactFile(
      root,
      'outputs/a.md',
      () => {
        if (!current) throw Error('host revoked');
      },
      undefined,
      run,
    ),
  ).rejects.toThrow('host revoked');
});

it('refuses a changed file after the initial helper returns, before the final authority continuation', async () => {
  const root = workspace();
  const run: ArtifactCommandRunner = async (command, args) => {
    const stdout = execFileSync(command, [...args], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    writeFileSync(join(root, 'outputs/a.md'), 'CHANGED NOW!');
    return stdout;
  };
  await expect(
    captureLocalArtifactFile(root, 'outputs/a.md', () => {}, undefined, run),
  ).rejects.toThrow();
});

it.each(['../outside.md', '.env', '.codex/auth.json', '/etc/passwd'])(
  'preserves existing outside/private path refusal for %s',
  async (path) => {
    const root = workspace();
    await expect(captureLocalArtifactFile(root, path, () => {})).rejects.toThrow();
  },
);

it.each([async () => {}, () => false])('refuses non-synchronous host assertions', async (guard) => {
  const root = workspace();
  await expect(captureLocalArtifactFile(root, 'outputs/a.md', guard)).rejects.toThrow();
});

it('refuses cancellation and oversize while retaining an exact empty file', async () => {
  const root = workspace();
  writeFileSync(join(root, 'empty.md'), '');
  const file = await captureLocalArtifactFile(root, 'empty.md', () => {});
  expect(file.bytes.length).toBe(0);
  file.assertCurrentSync();
  writeFileSync(join(root, 'big.md'), Buffer.alloc(5 * 1024 * 1024 + 1));
  await expect(captureLocalArtifactFile(root, 'big.md', () => {})).rejects.toThrow();
  const controller = new AbortController();
  const captured = await captureLocalArtifactFile(
    root,
    'outputs/a.md',
    () => {},
    controller.signal,
  );
  controller.abort();
  expect(() => captured.assertCurrentSync()).toThrow();
});
