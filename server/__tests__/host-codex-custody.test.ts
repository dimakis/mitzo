import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexConversationStore } from '../codex-conversation-store.js';
import type { HostCodexCustody } from '../host-codex-custody.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const binding = {
  accountId: 'personal',
  accountLabel: 'Personal',
  provider: 'openai-codex' as const,
  profileRevision: 'profile',
  model: 'fixture-model',
};
function snapshot(): HostCodexCustody {
  const identity = { dev: 1, ino: 2 },
    auth = { ...identity, sha256: 'a'.repeat(64) };
  const directory = { dev: '1', ino: '2', uid: '1', mode: '448' };
  const metadata = {
    ...directory,
    size: '7',
    mtimeNs: '1',
    ctimeNs: '1',
    nlink: '1',
    sha256: 'b'.repeat(64),
  };
  return {
    version: 1,
    authSessionId: 'original-login',
    bootstrapId: 'c'.repeat(64),
    login: {
      privateHome: '/private/home',
      sourcePath: '/private/source',
      sourceRoot: identity,
      sourceAuth: auth,
      homeRoot: identity,
      homeAuth: auth,
    },
    executable: {
      path: '/private/home/codex-runtime',
      source: '/private/codex',
      sha256: metadata.sha256,
      sourceIdentity: metadata,
      ownedIdentity: metadata,
      sourceDirectory: directory,
      ownedDirectory: directory,
    },
  };
}
it('retains original operator and physical custody across reopened competing native stores', () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-custody-store-'));
  roots.push(root);
  const path = join(root, 'native.db'),
    first = new CodexConversationStore(path),
    second = new CodexConversationStore(path);
  try {
    first.create('session', binding, '/task');
    first.setHostCustody('session', binding, snapshot());
    first.bindThread('session', binding, 'original-thread');
    expect(second.readHostCustody('session', binding)).toEqual(snapshot());
    second.setHostCustody('session', binding, snapshot());
    expect(() =>
      second.setHostCustody('session', binding, { ...snapshot(), authSessionId: 'other-login' }),
    ).toThrow();
    expect(() => second.readHostCustody('session', { ...binding, model: 'other' })).toThrow();
    expect(first.read('session', binding).threadId).toBe('original-thread');
  } finally {
    first.close();
    second.close();
  }
  const reopened = new CodexConversationStore(path);
  try {
    expect(reopened.readHostCustody('session', binding)?.authSessionId).toBe('original-login');
  } finally {
    reopened.close();
  }
});
it('refuses to invent custody for legacy native history or queued commands', () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-custody-legacy-'));
  roots.push(root);
  const store = new CodexConversationStore(join(root, 'native.db'));
  try {
    store.create('history', binding, '/task');
    store.bindThread('history', binding, 'legacy-thread');
    expect(store.readHostCustody('history', binding)).toBeNull();
    expect(() => store.setHostCustody('history', binding, snapshot())).toThrow();
    store.create('queue', binding, '/task');
    store.enqueue('queue', binding, { id: 'queued', prompt: 'Original', model: binding.model });
    expect(() => store.setHostCustody('queue', binding, snapshot())).toThrow();
  } finally {
    store.close();
  }
});
