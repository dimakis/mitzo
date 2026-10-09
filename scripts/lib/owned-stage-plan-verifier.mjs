import { join, resolve } from 'node:path';
import { lstatSync } from 'node:fs';
import { z } from 'zod';
import { bytes, hash, git } from './staging-cold-audit.mjs';
import { verifyPreparedController } from './staging-cold-control.mjs';
const sha = z.string().regex(/^[a-f0-9]{40}$/),
  digest = z.string().regex(/^[a-f0-9]{64}$/);
const Controller = z.strictObject({ controllerSource: sha, controllerReceiptSha256: digest });
export const MetadataVerifierQualification = z.strictObject({
  version: z.literal(1),
  originalControllerSource: sha,
  originalControllerReceiptSha256: digest,
  originalControllerTree: sha,
  verifierSource: sha,
  verifierReceiptSha256: digest,
  verifierTree: sha,
});
/** A newer exact accepted metadata verifier may acknowledge the same old effect.
 * It cannot rewrite the original operation's authority or perform its disposition. */
export function qualifyCompletedPlanVerifier(root, originalRaw, verifierRaw, accepted) {
  const original = Controller.parse(originalRaw),
    verifier = Controller.parse(verifierRaw);
  if (typeof accepted !== 'function' || accepted() !== verifier.controllerSource)
    throw Error('Exact current accepted metadata verifier required');
  function prepared(selected) {
    const source = join(root, 'releases', selected.controllerSource.slice(0, 12));
    if (
      git(source, 'replace', '--list') ||
      lstatSync(resolve(source, git(source, 'rev-parse', '--git-path', 'info/grafts')), {
        throwIfNoEntry: false,
      })
    )
      throw Error('Replaced or grafted Git ancestry cannot qualify metadata authority');
    if (
      git(source, 'rev-parse', 'HEAD') !== selected.controllerSource ||
      git(source, 'remote', 'get-url', 'origin') !== 'https://github.com/dimakis/mitzo.git' ||
      git(source, 'status', '--porcelain', '--untracked-files=no') ||
      hash(bytes(join(source, 'staging-release.json'))) !== selected.controllerReceiptSha256
    )
      throw Error('Immutable original/current prepared metadata controller drift');
    return verifyPreparedController(root, source, selected.controllerSource);
  }
  const old = prepared(original),
    current = prepared(verifier);
  git(
    join(root, 'releases', verifier.controllerSource.slice(0, 12)),
    '--no-replace-objects',
    'merge-base',
    '--is-ancestor',
    original.controllerSource,
    verifier.controllerSource,
  );
  return MetadataVerifierQualification.parse({
    version: 1,
    originalControllerSource: original.controllerSource,
    originalControllerReceiptSha256: original.controllerReceiptSha256,
    originalControllerTree: old.sourceTree,
    verifierSource: verifier.controllerSource,
    verifierReceiptSha256: verifier.controllerReceiptSha256,
    verifierTree: current.sourceTree,
  });
}
