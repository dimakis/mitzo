import { lstatSync, readFileSync } from 'node:fs';

/** Descriptive correlation only. A release manifest never grants execution,
 * publication or source authority. Missing/ambiguous metadata remains unknown. */
export function readDiagnosticReleaseRevision(path: string | URL): string | undefined {
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.size > 65536) return;
    const fields = readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('source_commit='));
    if (fields.length !== 1) return;
    const revision = fields[0].slice('source_commit='.length);
    return /^[a-f0-9]{40}$/.test(revision) ? revision : undefined;
  } catch {
    return undefined;
  }
}

// One startup observation; no Git process or filesystem traversal at failures.
export const diagnosticReleaseRevision = readDiagnosticReleaseRevision(
  new URL('../release.txt', import.meta.url),
);
