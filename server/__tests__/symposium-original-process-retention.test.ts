import { it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, chmodSync, readdirSync, readFileSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createOriginalProcessRecorder,
  createPrivateOriginalProcessJournal,
} from '../symposium-original-process-retention.js';
function fixture() {
  const child = Object.assign(new EventEmitter(), {
    pid: 4321,
    exitCode: null,
    signalCode: null,
    killed: false,
  }) as unknown as ChildProcess;
  const read = vi.fn((pid: number) => ({
    pid,
    parentPid: pid === process.pid ? process.ppid : process.pid,
    uid: process.getuid!(),
    domain: 'a'.repeat(64),
    birth: pid === process.pid ? '100:1' : '101:2',
  }));
  const append = vi.fn();
  return { child, read, append, current: vi.fn() };
}
it('records exact child and creating owner kernel births as immutable finite values', () => {
  const f = fixture();
  createOriginalProcessRecorder({ readKernelBirth: f.read, append: f.append })(
    'controller',
    f.child,
    f.current,
  );
  expect(f.read.mock.calls).toEqual([[process.pid], [4321], [process.pid], [4321]]);
  const r = f.append.mock.calls[0][0];
  expect(r.child.pid).toBe(4321);
  expect(r.owner.pid).toBe(process.pid);
  expect(Object.isFrozen(r.child)).toBe(true);
});
it.each(['birth', 'parent', 'domain', 'uid', 'exit', 'current'] as const)(
  'refuses %s change before append',
  (kind) => {
    const f = fixture();
    let n = 0;
    const original = f.read.getMockImplementation()!;
    f.read.mockImplementation((pid) => {
      const v = original(pid);
      if (++n === 4) {
        if (kind === 'birth') v.birth = '102:2';
        if (kind === 'parent') v.parentPid++;
        if (kind === 'domain') v.domain = 'b'.repeat(64);
        if (kind === 'uid') v.uid++;
        if (kind === 'exit') {
          f.child.emit('exit');
          Object.assign(f.child, { exitCode: 1 });
        }
      }
      return v;
    });
    if (kind === 'current')
      f.current.mockImplementationOnce(() => {
        throw Error('lost');
      });
    expect(() =>
      createOriginalProcessRecorder({ readKernelBirth: f.read, append: f.append })(
        'gateway',
        f.child,
        f.current,
      ),
    ).toThrow();
    expect(f.append).not.toHaveBeenCalled();
  },
);
it('never retries append failure or reads a replaced/discovered child identity', () => {
  const f = fixture();
  f.append.mockImplementation(() => {
    throw Error('uncertain durable write');
  });
  const record = createOriginalProcessRecorder({ readKernelBirth: f.read, append: f.append });
  expect(() => record('gateway', f.child, f.current)).toThrow();
  expect(() => record('gateway', f.child, f.current)).toThrow();
  expect(f.append).toHaveBeenCalledTimes(1);
});
it('retains already-written record but refuses loss after append', () => {
  const f = fixture();
  f.append.mockImplementation(() => Object.assign(f.child, { exitCode: 1 }));
  expect(() =>
    createOriginalProcessRecorder({ readKernelBirth: f.read, append: f.append })(
      'gateway',
      f.child,
      f.current,
    ),
  ).toThrow();
  expect(f.append).toHaveBeenCalledTimes(1);
});
it('writes private fresh fsynced finite journal containing no request or credential fields', () => {
  const f = fixture(),
    dir = mkdtempSync(join(tmpdir(), 'process-journal-test-'));
  chmodSync(dir, 0o700);
  const journal = createPrivateOriginalProcessJournal(dir, f.read);
  try {
    journal('gateway', f.child, f.current);
    const paths = readdirSync(dir);
    expect(paths).toHaveLength(1);
    const p = join(dir, paths[0]);
    expect(lstatSync(p).mode & 0o777).toBe(0o600);
    expect(Object.keys(JSON.parse(readFileSync(p, 'utf8')))).toEqual(['role', 'owner', 'child']);
  } finally {
    journal.close();
    rmSync(dir, { recursive: true });
  }
});
