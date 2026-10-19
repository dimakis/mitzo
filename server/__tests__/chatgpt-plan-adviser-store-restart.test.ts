import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { FilePlanAdviserStore } from '../chatgpt-plan-adviser-store.js';

const children = new Set<ChildProcess>();
let root: string;
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
  children.clear();
  if (root) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'plan-store-restart-')));
  chmodSync(root, 0o700);
  return root;
}
async function starter() {
  const child = fork(
    fileURLToPath(new URL('./fixtures/plan-adviser-store-owner.ts', import.meta.url)),
    [root],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  children.add(child);
  let stderr = '';
  child.stderr?.on('data', (data) => {
    stderr = (stderr + String(data)).slice(-4096);
  });
  const result = await new Promise<{ ok: boolean; state?: { hostId: string } }>(
    (resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Fixture startup timed out: ' + stderr)), 8000);
      child.once('message', (message) => {
        clearTimeout(timer);
        resolve(message as { ok: boolean; state?: { hostId: string } });
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(Error('Fixture exited before readiness: ' + stderr));
      });
    },
  );
  return { child, ...result };
}
async function crash(child: ChildProcess) {
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}
function retained() {
  return readdirSync(root).filter((name) => name.startsWith('owner.lock.retained-'));
}

it('recovers kernel ownership after abrupt exit and preserves account bytes and owner evidence', async () => {
  fixture();
  const first = await starter();
  expect(first.ok).toBe(true);
  const original = readFileSync(join(root, 'owner.lock'), 'utf8');
  const accounts = readFileSync(join(root, 'accounts.json'));
  await crash(first.child);
  const replacement = new FilePlanAdviserStore(root);
  try {
    expect(replacement.load().hostId).toBe(first.state!.hostId);
    expect(readFileSync(join(root, 'accounts.json'))).toEqual(accounts);
    expect(retained()).toHaveLength(1);
    expect(readFileSync(join(root, retained()[0]), 'utf8')).toBe(original);
    expect(() => new FilePlanAdviserStore(root)).toThrow();
  } finally {
    replacement.close();
  }
}, 15000);

it('does not mistake a reused PID for a live store owner after its kernel lock is released', async () => {
  fixture();
  const first = await starter();
  expect(first.ok).toBe(true);
  await crash(first.child);
  const owner = JSON.parse(readFileSync(join(root, 'owner.lock'), 'utf8'));
  writeFileSync(join(root, 'owner.lock'), JSON.stringify({ ...owner, pid: process.pid }));
  const replacement = new FilePlanAdviserStore(root);
  replacement.close();
  expect(retained()).toHaveLength(1);
}, 15000);

it('admits exactly one concurrent replacement after a crash without disturbing the winner', async () => {
  fixture();
  const first = await starter();
  expect(first.ok).toBe(true);
  const accounts = readFileSync(join(root, 'accounts.json'));
  await crash(first.child);
  const candidates = await Promise.all([starter(), starter()]);
  expect(candidates.filter((candidate) => candidate.ok)).toHaveLength(1);
  expect(retained()).toHaveLength(1);
  expect(readFileSync(join(root, 'accounts.json'))).toEqual(accounts);
  const winner = candidates.find((candidate) => candidate.ok)!;
  expect(JSON.parse(readFileSync(join(root, 'owner.lock'), 'utf8')).pid).toBe(winner.child.pid);
  const exited = once(winner.child, 'exit');
  winner.child.send('close');
  await exited;
  const reopened = new FilePlanAdviserStore(root);
  reopened.close();
}, 15000);

it.each(['symlink', 'hardlink', 'permissions'] as const)(
  'refuses an unsafe kernel fence: %s',
  (kind) => {
    fixture();
    const store = new FilePlanAdviserStore(root);
    const owner = readFileSync(join(root, 'owner.lock'), 'utf8');
    store.close();
    writeFileSync(join(root, 'owner.lock'), owner, { mode: 0o600 });
    const fence = join(root, 'owner.fence.db');
    if (kind === 'symlink') {
      renameSync(fence, fence + '.original');
      symlinkSync(fence + '.original', fence);
    } else if (kind === 'hardlink') linkSync(fence, fence + '.other');
    else chmodSync(fence, 0o644);
    expect(() => new FilePlanAdviserStore(root)).toThrow();
    expect(readFileSync(join(root, 'owner.lock'), 'utf8')).toBe(owner);
    expect(retained()).toHaveLength(0);
  },
);

it('retains ownership when the kernel-fence path is replaced', () => {
  fixture();
  const store = new FilePlanAdviserStore(root);
  const original = readFileSync(join(root, 'owner.lock'), 'utf8');
  try {
    renameSync(join(root, 'owner.fence.db'), join(root, 'original.fence.db'));
    writeFileSync(join(root, 'owner.fence.db'), '', { mode: 0o600 });
    expect(() => store.assertCurrent()).toThrow();
    expect(() => new FilePlanAdviserStore(root)).toThrow();
    store.close();
    expect(readFileSync(join(root, 'owner.lock'), 'utf8')).toBe(original);
    expect(retained()).toHaveLength(0);
  } finally {
    store.close();
  }
});

it('leaves legacy ownership without kernel evidence for explicit host recovery', () => {
  fixture();
  const original = JSON.stringify({ version: 1, pid: 2147483647, claim: 'legacy-owner' });
  writeFileSync(join(root, 'owner.lock'), original, { mode: 0o600 });
  expect(() => new FilePlanAdviserStore(root)).toThrow();
  expect(readFileSync(join(root, 'owner.lock'), 'utf8')).toBe(original);
  expect(retained()).toHaveLength(0);
});

it('keeps the live kernel fence after a rejected same-process contender', async () => {
  fixture();
  const store = new FilePlanAdviserStore(root);
  try {
    expect(() => new FilePlanAdviserStore(root)).toThrow();
    const external = await starter();
    expect(external.ok).toBe(false);
    expect(() => store.assertCurrent()).not.toThrow();
    expect(retained()).toHaveLength(0);
  } finally {
    store.close();
  }
}, 15000);
