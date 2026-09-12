import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { captureOpenShellCheckpoint, restoreOpenShellCheckpoint } from '../openshell-checkpoint.js';

const roots: string[] = [];
function root() {
  const value = mkdtempSync(join(tmpdir(), 'mitzo-openshell-checkpoint-'));
  roots.push(value);
  return value;
}
function write(root: string, path: string, content: string) {
  const destination = join(root, path);
  mkdirSync(join(destination, '..'), { recursive: true });
  writeFileSync(destination, content, { mode: 0o600 });
}
function provider(root: string) {
  write(root, 'state_5.sqlite', 'state');
  write(root, 'state_5.sqlite-wal', 'wal');
  write(root, 'sessions/thread.jsonl', '{"id":"thread-1"}');
  write(root, 'installation_id', 'install');
}
afterEach(() => {
  for (const value of roots) rmSync(value, { recursive: true, force: true });
  roots.length = 0;
});

it('round-trips exact supported Codex state and workspace with a verified manifest', () => {
  const source = root();
  const checkpoint = join(root(), 'checkpoint');
  const restored = join(root(), 'restored');
  provider(join(source, '.codex'));
  write(join(source, 'workspace'), 'notes.txt', 'preserve this');
  write(join(source, 'workspace'), 'manifest.json', 'ordinary user file');
  const manifest = captureOpenShellCheckpoint({
    source,
    destination: checkpoint,
    conversationId: 'conversation',
    threadId: 'thread-1',
    sandboxId: 'physical-1',
    bindingKey: 'account-binding',
  });
  expect(manifest.version).toBe(1);
  restoreOpenShellCheckpoint({
    checkpoint,
    destination: restored,
    conversationId: 'conversation',
    threadId: 'thread-1',
    bindingKey: 'account-binding',
  });
  expect(readFileSync(join(restored, '.codex/sessions/thread.jsonl'), 'utf8')).toContain(
    'thread-1',
  );
  expect(readFileSync(join(restored, 'workspace/notes.txt'), 'utf8')).toBe('preserve this');
  expect(readFileSync(join(restored, 'workspace/manifest.json'), 'utf8')).toBe(
    'ordinary user file',
  );
});

it('blocks unknown provider files and credential-like workspace files instead of omitting them', () => {
  const source = root();
  provider(join(source, '.codex'));
  write(join(source, '.codex'), 'auth.json', 'secret');
  expect(() =>
    captureOpenShellCheckpoint({
      source,
      destination: join(root(), 'checkpoint'),
      conversationId: 'conversation',
      threadId: 'thread-1',
      sandboxId: 'physical-1',
      bindingKey: 'account-binding',
    }),
  ).toThrow('unsupported provider');
  rmSync(join(source, '.codex/auth.json'));
  write(join(source, 'workspace'), '.env', 'secret');
  expect(() =>
    captureOpenShellCheckpoint({
      source,
      destination: join(root(), 'checkpoint'),
      conversationId: 'conversation',
      threadId: 'thread-1',
      sandboxId: 'physical-1',
      bindingKey: 'account-binding',
    }),
  ).toThrow('credential-like');
});

it('rejects corrupted manifests and mismatched conversation identity', () => {
  const source = root();
  const checkpoint = join(root(), 'checkpoint');
  provider(join(source, '.codex'));
  mkdirSync(join(source, 'workspace'));
  captureOpenShellCheckpoint({
    source,
    destination: checkpoint,
    conversationId: 'conversation',
    threadId: 'thread-1',
    sandboxId: 'physical-1',
    bindingKey: 'binding',
  });
  writeFileSync(join(checkpoint, 'manifest.json'), '{bad');
  expect(() =>
    restoreOpenShellCheckpoint({
      checkpoint,
      destination: join(root(), 'restored'),
      conversationId: 'other',
      threadId: 'thread-1',
      bindingKey: 'binding',
    }),
  ).toThrow();
});
