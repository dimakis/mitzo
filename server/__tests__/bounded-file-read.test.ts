import { expect, it } from 'vitest';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBoundedFile } from '../bounded-file-read.js';

it('reads exact bytes within the limit and refuses additional bytes without a size hint', () => {
  const root = mkdtempSync(join(tmpdir(), 'mitzo-bounded-read-'));
  const path = join(root, 'saved.txt');
  try {
    writeFileSync(path, '12345678');
    const fd = openSync(path, 'r');
    try {
      expect(readBoundedFile(fd, 8).toString()).toBe('12345678');
      // The open file may have grown since the caller checked its metadata.
      writeFileSync(path, '123456789');
      expect(() => readBoundedFile(fd, 8)).toThrow(/too large/);
    } finally {
      closeSync(fd);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
