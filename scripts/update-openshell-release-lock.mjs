#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function updateReleasePins({
  manifest,
  environment,
  image,
  digest,
  mitzoCommit,
  mgmtCommit,
  policyDigest,
}) {
  invariant(
    /^[^\s:]+(?:\/[^\s:]+)*:[^\s:]+$/.test(image) && !/:(?:latest|dev)$/.test(image),
    'runtime image must use an explicit immutable tag',
  );
  invariant(/^sha256:[0-9a-f]{64}$/.test(digest), 'runtime digest must be sha256');
  invariant(/^[0-9a-f]{40}$/.test(mitzoCommit), 'Mitzo source commit must be full SHA-1');
  invariant(/^[0-9a-f]{40}$/.test(mgmtCommit), 'MGMT source commit must be full SHA-1');
  invariant(/^[0-9a-f]{64}$/.test(policyDigest), 'policy digest must be SHA-256');
  invariant(
    manifest?.schemaVersion === 1 && manifest.runtime && manifest.policy,
    'invalid production stack lock',
  );

  const nextManifest = structuredClone(manifest);
  Object.assign(nextManifest.runtime, {
    image,
    digest,
    mitzoSourceCommit: mitzoCommit,
    mgmtSourceCommit: mgmtCommit,
  });
  nextManifest.policy.sha256 = policyDigest;

  const imageLine = /^MITZO_OPENSHELL_IMAGE=.*$/m;
  invariant(imageLine.test(environment), 'production environment example has no image pin');
  const nextEnvironment = environment.replace(imageLine, `MITZO_OPENSHELL_IMAGE=${image}`);
  return { manifest: nextManifest, environment: nextEnvironment };
}

export function main(argv = process.argv.slice(2)) {
  const [image, digest, mitzoCommit, mgmtCommit, policyDigest] = argv;
  invariant(
    image && digest && mitzoCommit && mgmtCommit && policyDigest,
    'usage: update-openshell-release-lock IMAGE DIGEST MITZO_COMMIT MGMT_COMMIT POLICY_SHA256',
  );
  const manifestPath = resolve(repoRoot, 'infra/openshell/production-stack.lock.json');
  const environmentPath = resolve(repoRoot, 'infra/openshell/production.env.example');
  const currentManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const currentEnvironment = readFileSync(environmentPath, 'utf8');
  const updated = updateReleasePins({
    manifest: currentManifest,
    environment: currentEnvironment,
    image,
    digest,
    mitzoCommit,
    mgmtCommit,
    policyDigest,
  });
  writeFileSync(manifestPath, `${JSON.stringify(updated.manifest, null, 2)}\n`);
  writeFileSync(environmentPath, updated.environment);
  console.log(`OPENSHELL_RELEASE_LOCK_UPDATED=${image}@${digest}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'unknown release-lock error');
    process.exitCode = 1;
  }
}
