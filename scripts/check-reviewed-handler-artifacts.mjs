import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';
import process from 'node:process';
const fix = process.argv.includes('--fix');
const manifestPath = fileURLToPath(
  new URL('../server/connections/reviewed-handler-artifacts.ts', import.meta.url),
);
const {
  reviewedHandlerImplementationRevision,
  reviewedConnectionsRuntimeImplementationRevision,
  reviewedHandlerSourceArtifacts,
  reviewedHandlerSourceFingerprint,
} = await import(
  process.argv.includes('--source') || fix
    ? '../server/connections/reviewed-handler-artifacts.ts'
    : '../dist/connections/reviewed-handler-artifacts.js'
);

const root = fileURLToPath(new URL('..', import.meta.url));
const sourceDirectory = resolve(root, 'server/connections');
const files = Object.keys(reviewedHandlerSourceArtifacts);
const current = Object.fromEntries(
  await Promise.all(
    files.map(async (file) => {
      try {
        return [
          file,
          reviewedHandlerSourceFingerprint(await readFile(resolve(sourceDirectory, file), 'utf8')),
        ];
      } catch (error) {
        if (error?.code === 'ENOENT')
          throw Error(`Registered reviewed source is missing: ${file}. Remove its entry.`, {
            cause: error,
          });
        throw error;
      }
    }),
  ),
);

if (process.argv.includes('--print')) {
  // Let stdout drain: exiting immediately truncates piped output at 64 KiB.
  process.stdout.write(`${JSON.stringify(current, null, 2)}\n`);
} else if (fix) {
  const { rewriteReviewedHandlerArtifacts } =
    await import('./lib/reviewed-handler-artifacts-fix.mjs');
  const prettier = await import('prettier');
  const rewritten = rewriteReviewedHandlerArtifacts(await readFile(manifestPath, 'utf8'), current);
  const options = (await prettier.resolveConfig(manifestPath)) ?? {};
  await writeFile(
    manifestPath,
    await prettier.format(rewritten.source, { ...options, filepath: manifestPath }),
  );
  process.stdout.write(
    rewritten.updated.length
      ? `Updated ${rewritten.updated.length} reviewed source fingerprint(s):\n${rewritten.updated.map((file) => `  ${file}\n`).join('')}`
      : 'Reviewed source fingerprints already current.\n',
  );
} else {
  const mismatches = files.filter((file) => current[file] !== reviewedHandlerSourceArtifacts[file]);
  if (mismatches.length > 0)
    throw new Error(
      `Reviewed handler source artifact mismatch: ${mismatches.join(', ')}. ` +
        'Review the change, then run npm run fix:reviewed-handler-artifacts.',
    );
  process.stdout.write(
    `Reviewed handler artifacts verified for ${reviewedHandlerImplementationRevision}; Connections runtime ${reviewedConnectionsRuntimeImplementationRevision}.\n`,
  );
}
