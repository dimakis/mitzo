import { afterEach, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrozenHostCodexExecutable } from '../frozen-host-codex-executable.js';
import { CodexConversationStore } from '../codex-conversation-store.js';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'host-bundle-upgrade-')));
  roots.push(root);
  const home = join(root, 'private'),
    source = join(root, 'codex'),
    path = join(root, 'native.db');
  mkdirSync(home, { mode: 0o700 });
  const bytes = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3]);
  writeFileSync(source, bytes, { mode: 0o755 });
  const executable = FrozenHostCodexExecutable.capture(source, home).custodySnapshot();
  const binding = {
    accountId: 'fixture',
    provider: 'openai-codex' as const,
    profileRevision: 'r1',
    accountLabel: 'Offline',
    model: 'luna-fixture',
  };
  const custody = {
    version: 1 as const,
    authSessionId: 'creating-login',
    bootstrapId: 'a'.repeat(64),
    login: {
      privateHome: home,
      sourcePath: join(root, 'login'),
      sourceRoot: { dev: 1, ino: 2 },
      sourceAuth: { dev: 1, ino: 3, sha256: 'b'.repeat(64) },
      homeRoot: { dev: 1, ino: 4 },
      homeAuth: { dev: 1, ino: 5, sha256: 'b'.repeat(64) },
    },
    executable,
  };
  let store = new CodexConversationStore(path);
  store.create('chat', binding, root);
  store.setHostCustody('chat', binding, custody);
  store.bindThread('chat', binding, 'original-thread');
  writeFileSync(join(root, 'codex-code-mode-host'), bytes, { mode: 0o755 });
  return {
    root,
    home,
    bytes,
    binding,
    custody,
    get store() {
      return store;
    },
    reopen() {
      store.close();
      store = new CodexConversationStore(path);
    },
    complete() {
      store.completeHostRuntimeBundle(
        'chat',
        binding,
        custody,
        FrozenHostCodexExecutable.reopen(custody.executable),
      );
    },
  };
}
it.each(['after-intent', 'partial-copy', 'after-copy', 'custody-commit'] as const)(
  'recovers the exact owned companion upgrade after interruption at %s',
  (phase) => {
    const f = fixture();
    try {
      const original = FrozenHostCodexExecutable.prototype.completeRuntimeBundle;
      const fail =
        phase === 'custody-commit'
          ? vi.spyOn(f.store, 'setHostCustody').mockImplementationOnce(() => {
              throw Error('Injected custody commit failure');
            })
          : vi
              .spyOn(FrozenHostCodexExecutable.prototype, 'completeRuntimeBundle')
              .mockImplementationOnce(function (this: FrozenHostCodexExecutable, ...args) {
                if (phase === 'partial-copy')
                  writeFileSync(join(f.home, 'codex-code-mode-host'), f.bytes.subarray(0, 2), {
                    mode: 0o500,
                  });
                if (phase === 'after-copy') original.apply(this, args);
                throw Error('Injected startup interruption');
              });
      expect(() => f.complete()).toThrow('Injected');
      fail.mockRestore();
      expect(f.store.readHostCustody('chat', f.binding)).toEqual(f.custody);
      f.reopen();
      expect(() => f.complete()).not.toThrow();
      const completed = f.store.readHostCustody('chat', f.binding)!;
      const { codeModeHost, ...originalMain } = completed.executable;
      expect({ ...completed, executable: originalMain }).toEqual(f.custody);
      expect(codeModeHost?.path).toBe(join(f.home, 'codex-code-mode-host'));
      expect(readFileSync(codeModeHost!.path)).toEqual(f.bytes);
      expect(f.store.read('chat', f.binding).threadId).toBe('original-thread');
      expect(() => FrozenHostCodexExecutable.reopen(completed.executable)).not.toThrow();
    } finally {
      f.store.close();
    }
  },
);
it('refuses an unexplained destination and a changed journaled source instead of adopting them', () => {
  const f = fixture();
  try {
    const destination = join(f.home, 'codex-code-mode-host');
    writeFileSync(destination, f.bytes, { mode: 0o500 });
    expect(() => f.complete()).toThrow();
    expect(readFileSync(destination)).toEqual(f.bytes);
    rmSync(destination);
    const fail = vi
      .spyOn(FrozenHostCodexExecutable.prototype, 'completeRuntimeBundle')
      .mockImplementationOnce(() => {
        throw Error('Injected');
      });
    expect(() => f.complete()).toThrow('Injected');
    fail.mockRestore();
    writeFileSync(
      join(f.root, 'codex-code-mode-host'),
      Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 4, 5]),
      { mode: 0o755 },
    );
    f.reopen();
    expect(() => f.complete()).toThrow();
    expect(existsSync(destination)).toBe(false);
    expect(f.store.readHostCustody('chat', f.binding)).toEqual(f.custody);
  } finally {
    f.store.close();
  }
});
