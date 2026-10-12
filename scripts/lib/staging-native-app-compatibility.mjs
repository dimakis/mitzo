import process from 'node:process';
import { userInfo } from 'node:os';
import { join, relative } from 'node:path';
import { lstatSync, realpathSync, readlinkSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { verifyPreparedController } from './staging-cold-control.mjs';
import { fingerprintDependencyCopy } from './staging-files.mjs';
import { bytes, hash, inventory, git } from './staging-cold-audit.mjs';
import { deriveRetainedNativeImportClosure } from './staging-native-import-closure.mjs';
import { assertByteCompatibleNativeApp } from './staging-native-app-source.mjs';
import { captureOriginalNativeSourceContinuity } from './staging-native-source-continuity.mjs';
const refuse = () =>
  Error(
    'Complete native app compatibility proof unavailable; retained runtime cannot be updated by a child replacement',
  );
const digest = (input) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
/** Actual immutable prepared release inspector. Verification covers full receipt,
 * compiled files and dependency closure before and after comparison. Comparing
 * copied dependency entries alone never qualifies a release; all workspace
 * targets are checked independently below. No native/control state is read from
 * candidate JSON or reconstructed into ownership. */
export function createNativeAppCompatibilityInspector({
  canonicalRoot,
  nativeSourceRoot,
  nativeCommit,
}) {
  if (
    canonicalRoot !== join(userInfo().homedir, '.local/share/mitzo-staging') ||
    !/^[a-f0-9]{40}$/.test(nativeCommit) ||
    nativeSourceRoot !== join(canonicalRoot, 'releases', nativeCommit.slice(0, 12))
  )
    throw refuse();
  const inspect = (selected) => {
    if (!/^[a-f0-9]{40}$/.test(selected)) throw refuse();
    const sourceRoot = join(canonicalRoot, 'releases', selected.slice(0, 12));
    if (
      realpathSync(sourceRoot) !== sourceRoot ||
      git(sourceRoot, 'rev-parse', 'HEAD') !== selected ||
      !['', '?? staging-release.json'].includes(git(sourceRoot, 'status', '--porcelain'))
    )
      throw refuse();
    const first = verifyPreparedController(canonicalRoot, sourceRoot, selected);
    const snapshot = {
      sourceCommit: selected,
      sourceRoot,
      runtimeArtifactsSha256: deriveRetainedNativeImportClosure({
        readModule(path) {
          const body = bytes(join(sourceRoot, path));
          if (Object.hasOwn(first.compiledArtifacts, path)) {
            if (hash(body) !== first.compiledArtifacts[path]) throw refuse();
          } else {
            // Noncompiled literal data/helper assets must be actual tracked
            // immutable source, never candidate JSON or an untracked file.
            if (git(sourceRoot, 'ls-files', '--error-unmatch', '--', path) !== path) throw refuse();
            const stat = lstatSync(join(sourceRoot, path));
            if (
              !stat.isFile() ||
              stat.isSymbolicLink() ||
              stat.uid !== process.getuid() ||
              stat.nlink !== 1 ||
              stat.mode & 0o022 ||
              realpathSync(join(sourceRoot, path)) !== join(sourceRoot, path)
            )
              throw refuse();
          }
          return body.toString('utf8');
        },
      }).sha256,
      dependenciesSha256: fingerprintDependencyCopy(sourceRoot),
      workspaceDependenciesSha256: digest(inventory(join(sourceRoot, 'packages'))),
      controllerSourceSha256: digest(inventory(join(sourceRoot, 'scripts'))),
      packageInputsSha256: digest(
        Object.fromEntries(
          ['package.json', 'package-lock.json', 'frontend/package.json'].map((path) => [
            path,
            hash(bytes(join(sourceRoot, path))),
          ]),
        ),
      ),
      frontendArtifactsSha256: digest(
        Object.fromEntries(
          Object.entries(first.compiledArtifacts)
            .filter(([path]) => path.startsWith('frontend/dist/'))
            .sort(),
        ),
      ),
    };
    // Every workspace symlink must resolve to a known inspected tree. Other
    // dependency links stay inside node_modules and are covered by the full
    // prepared closure + entry-content comparison, never external aliases.
    const visit = (path) => {
      const s = lstatSync(path);
      if (s.uid !== process.getuid()) throw refuse();
      if (s.isSymbolicLink()) {
        const target = realpathSync(path),
          rel = relative(sourceRoot, target);
        if (rel === 'frontend') {
          if (
            relative(sourceRoot, path) !== 'node_modules/mitzo-frontend' ||
            readlinkSync(path) !== '../frontend'
          )
            throw refuse();
        } else if (
          !rel.startsWith('node_modules/') &&
          !/^packages\/(?:protocol|harness|client)$/.test(rel)
        )
          throw refuse();
      } else if (s.isDirectory()) {
        for (const name of readdirSync(path)) visit(join(path, name));
      } else if (!s.isFile()) throw refuse();
    };
    visit(join(sourceRoot, 'node_modules'));
    if (
      !['', '?? staging-release.json'].includes(git(sourceRoot, 'status', '--porcelain')) ||
      git(sourceRoot, 'rev-parse', 'HEAD') !== selected ||
      digest(verifyPreparedController(canonicalRoot, sourceRoot, selected)) !== digest(first)
    )
      throw refuse();
    return Object.freeze(snapshot);
  };
  const original = inspect(nativeCommit);
  let continuity;
  return Object.freeze({
    original,
    async prepareOriginalContinuity(assertRegisteredOriginalCurrent) {
      if (continuity || digest(inspect(nativeCommit)) !== digest(original)) throw refuse();
      continuity = await captureOriginalNativeSourceContinuity({
        sourceRoot: nativeSourceRoot,
        sourceCommit: nativeCommit,
        heldFileModuleSha256: verifyPreparedController(
          canonicalRoot,
          nativeSourceRoot,
          nativeCommit,
        ).compiledArtifacts['dist/native-held-file-custody.js'],
        assertRegisteredOriginalCurrent,
      });
      if (digest(inspect(nativeCommit)) !== digest(original)) throw refuse();
      continuity.assertCurrent();
      return continuity;
    },
    captureSourceContinuity(snapshot) {
      if (!continuity || digest(inspect(snapshot.sourceCommit)) !== digest(snapshot))
        throw refuse();
      return continuity.captureChild(snapshot);
    },
    inspect(selected) {
      if (digest(inspect(nativeCommit)) !== digest(original)) throw refuse();
      const candidate = inspect(selected);
      assertByteCompatibleNativeApp(original, candidate);
      return candidate;
    },
  });
}
