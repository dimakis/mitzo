import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { reviewedNativeContextSourceArtifacts } from '../dist/native-context-artifacts.js';
const directory = fileURLToPath(new URL('../server/connections/', import.meta.url));
const current = Object.fromEntries(
  await Promise.all(
    Object.keys(reviewedNativeContextSourceArtifacts).map(async (file) => [
      file,
      createHash('sha256')
        .update((await readFile(resolve(directory, file), 'utf8')).replace(/\r\n/g, '\n'))
        .digest('hex'),
    ]),
  ),
);
if (process.argv.includes('--print')) process.stdout.write(JSON.stringify(current, null, 2) + '\n');
else {
  const mismatches = Object.keys(current).filter(
    (file) => current[file] !== reviewedNativeContextSourceArtifacts[file],
  );
  if (mismatches.length)
    throw Error('Reviewed native context source artifact mismatch: ' + mismatches.join(', '));
}
