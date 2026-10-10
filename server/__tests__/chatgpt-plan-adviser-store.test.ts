import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { FilePlanAdviserStore } from '../chatgpt-plan-adviser-store.js';
import { isPrivateCodexPath } from '../codex-private-path.js';
it('protects stored credentials and retains one owner until confirmed close', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plan-store-')));
  chmodSync(root, 0o700);
  const store = new FilePlanAdviserStore(root);
  try {
    const state = store.load();
    expect(state.hostId).toMatch(/^urn:uuid:/);
    expect(isPrivateCodexPath(join(root, 'accounts.json'))).toBe(true);
    expect(() => new FilePlanAdviserStore(root)).toThrow();
    store.save(state);
    expect(lstatSync(join(root, 'accounts.json')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(root, 'accounts.json'), 'utf8')).hostId).toBe(state.hostId);
    store.close();
    const reopened = new FilePlanAdviserStore(root);
    expect(reopened.load().hostId).toBe(state.hostId);
    reopened.close();
    expect(() => store.save(state)).toThrow();
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
it('refuses loose permissions, symlinks and uncertain retained ownership', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'plan-store-')));
  try {
    chmodSync(root, 0o755);
    expect(() => new FilePlanAdviserStore(root)).toThrow();
    chmodSync(root, 0o700);
    writeFileSync(join(root, 'owner.lock'), 'retained owner', { mode: 0o600 });
    expect(() => new FilePlanAdviserStore(root)).toThrow();
    expect(readFileSync(join(root, 'owner.lock'), 'utf8')).toBe('retained owner');
    rmSync(join(root, 'owner.lock'));
    symlinkSync('/etc/passwd', join(root, 'accounts.json'));
    expect(() => new FilePlanAdviserStore(root)).toThrow();
    expect(lstatSync(join(root, 'accounts.json')).isSymbolicLink()).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
