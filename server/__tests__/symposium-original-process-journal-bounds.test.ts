import { it, expect, vi, afterEach } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, chmodSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const io = vi.hoisted(() => ({ mode: 'normal', writes: 0 }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    writeSync: (fd: number, bytes: Buffer) => {
      io.writes++;
      return fs.writeSync(fd, io.mode === 'short' ? bytes.subarray(0, 10) : bytes);
    },
    fsyncSync: (fd: number) => {
      if (io.mode === 'fsync-fail') throw Error('injected fsync uncertain');
      return fs.fsyncSync(fd);
    },
  };
});
import { createPrivateOriginalProcessJournal } from '../symposium-original-process-retention.js';
afterEach(() => {
  io.mode = 'normal';
  io.writes = 0;
});
function fixture(long = false) {
  const dir = mkdtempSync(join(tmpdir(), 'bounded-journal-'));
  chmodSync(dir, 0o700);
  const read = (pid: number) => ({
    pid,
    parentPid: pid === process.pid ? process.ppid : process.pid,
    uid: process.getuid!(),
    domain: 'a'.repeat(64),
    birth: long ? '99999999999999999999:99999999999999999999' : '1:1',
  });
  const journal = createPrivateOriginalProcessJournal(dir, read);
  const child = (pid = 4321) =>
    Object.assign(new EventEmitter(), {
      pid,
      exitCode: null,
      signalCode: null,
      killed: false,
    }) as unknown as ChildProcess;
  const bytes = () => readFileSync(join(dir, readdirSync(dir)[0]));
  return {
    dir,
    journal,
    child,
    bytes,
    close: () => {
      journal.close();
      rmSync(dir, { recursive: true });
    },
  };
}
it('caps repeated original fork records at 128 and permanently refuses later appends', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 128; i++) f.journal('controller', f.child(4321 + i), () => {});
    const before = f.bytes();
    expect(() => f.journal('controller', f.child(9999), () => {})).toThrow('budget');
    expect(() => f.journal('gateway', f.child(8888), () => {})).toThrow('fenced');
    expect(f.bytes()).toEqual(before);
    expect(io.writes).toBe(128);
  } finally {
    f.close();
  }
});
it('enforces total byte bound even with valid longest kernel birth fields', () => {
  const f = fixture(true);
  try {
    let n = 0;
    for (; n < 128; n++) {
      try {
        f.journal('controller', f.child(4321 + n), () => {});
      } catch {
        break;
      }
    }
    expect(n).toBeLessThan(128);
    expect(f.bytes().length).toBeLessThanOrEqual(45056);
    const before = f.bytes();
    expect(() => f.journal('gateway', f.child(8888), () => {})).toThrow('fenced');
    expect(f.bytes()).toEqual(before);
  } finally {
    f.close();
  }
});
it.each(['short', 'fsync-fail', 'postguard'] as const)(
  'preserves actual %s effect and never resends on a new fork',
  (mode) => {
    const f = fixture();
    try {
      io.mode = mode;
      let calls = 0;
      const current = () => {
        if (mode === 'postguard' && ++calls === 4) throw Error('postwrite guard lost');
      };
      expect(() => f.journal('controller', f.child(), current)).toThrow();
      const original = f.bytes();
      expect(original.length).toBeGreaterThan(0);
      if (mode === 'short') expect(original.length).toBe(10);
      io.mode = 'normal';
      expect(() => f.journal('controller', f.child(9876), () => {})).toThrow('fenced');
      expect(f.bytes()).toEqual(original);
      expect(io.writes).toBe(1);
    } finally {
      f.close();
    }
  },
);
