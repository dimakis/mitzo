import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { readDiagnosticReleaseRevision } from '../codex-diagnostic-release.js';

it('retains only an unambiguous bounded descriptive release revision', () => {
  const root = mkdtempSync(join(tmpdir(), 'diagnostic-release-'));
  try {
    const manifest = join(root, 'release.txt');
    expect(readDiagnosticReleaseRevision(manifest)).toBeUndefined();
    writeFileSync(manifest, 'source_commit=' + 'a'.repeat(40) + '\nsource_ref=SECRET\n');
    expect(readDiagnosticReleaseRevision(manifest)).toBe('a'.repeat(40));
    writeFileSync(
      manifest,
      'source_commit=' + 'a'.repeat(40) + '\nsource_commit=' + 'b'.repeat(40),
    );
    expect(readDiagnosticReleaseRevision(manifest)).toBeUndefined();
    writeFileSync(manifest, 'source_commit=SECRET /private/path');
    expect(readDiagnosticReleaseRevision(manifest)).toBeUndefined();
    writeFileSync(manifest, 'a'.repeat(65537));
    expect(readDiagnosticReleaseRevision(manifest)).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
