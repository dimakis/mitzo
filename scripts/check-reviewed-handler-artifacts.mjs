import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  reviewedHandlerImplementationRevision,
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} from '../dist/connections/reviewed-handler-artifacts.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const sourceDirectory = resolve(root, 'server/connections');
const files = Object.keys(reviewedHandlerSourceArtifacts);
const current = Object.fromEntries(
  await Promise.all(
    files.map(async (file) => [
      file,
      reviewedHandlerSourceFingerprint(await readFile(resolve(sourceDirectory, file), 'utf8')),
    ]),
  ),
);

if (process.argv.includes('--print')) {
  process.stdout.write(`${JSON.stringify(current, null, 2)}\n`);
  process.exit(0);
}

const mismatches = files.filter((file) => current[file] !== reviewedHandlerSourceArtifacts[file]);
if (mismatches.length > 0)
  throw new Error(
    `Reviewed handler source artifact mismatch: ${mismatches.join(', ')}. ` +
      'Bump the reviewed implementation/template version and regenerate the reviewed artifact.',
  );
process.stdout.write(
  `Reviewed handler artifacts verified for ${reviewedHandlerImplementationRevision}.\n`,
);
