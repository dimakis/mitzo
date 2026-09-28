import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { ARTIFACT_GIT_VERIFIER } from '../symposium-artifact-git-verifier.js';
import { ARTIFACT_GIT_EXPORT } from '../symposium-artifact-git-export.js';
import { TESTED_SYMPOSIUM_NATIVE_BUILD } from '../symposium-production-gate.js';
import { SYMPOSIUM_ARTIFACT_TARGET } from '../symposium-artifact-lease.js';

const volume = `mitzo-criterion-fixture-${randomUUID()}`;
const run = (args: string[]) =>
  execFileSync('podman', args, { encoding: 'utf8', timeout: 120_000 });
const image = TESTED_SYMPOSIUM_NATIVE_BUILD.image;
const mount = `type=volume,src=${volume},dst=${SYMPOSIUM_ARTIFACT_TARGET}`;
run(['volume', 'create', volume]);
try {
  run([
    'run',
    '--rm',
    '--network=none',
    '--mount',
    mount,
    '--entrypoint=/bin/sh',
    image,
    '-c',
    `set -eu
cd '${SYMPOSIUM_ARTIFACT_TARGET}'
git init -q -b feature
git config user.name Fixture
git config user.email fixture@example.invalid
printf 'criterion-ok\n' > marker.txt
git add marker.txt
git commit -qm initial`,
  ]);
  const constrained = [
    'run',
    '--rm',
    '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--user=sandbox',
    '--mount',
    `${mount},readonly`,
    '--entrypoint=/usr/bin/python3',
    image,
    '-I',
    '-c',
  ];
  const proof = JSON.parse(run([...constrained, ARTIFACT_GIT_VERIFIER, '.']));
  const checked = JSON.parse(
    run([
      ...constrained,
      ARTIFACT_GIT_EXPORT,
      '.',
      JSON.stringify({
        kind: 'check',
        checkPath: 'marker.txt',
        expected: proof,
      }),
    ]),
  );
  const expected = createHash('sha256').update('criterion-ok\n').digest('hex');
  if (
    checked.observedSha256 !== expected ||
    JSON.stringify(checked.proof) !== JSON.stringify(proof)
  )
    throw new Error('Physical criterion file check changed');
  process.stdout.write(JSON.stringify({ volume, image, proof, checked, expected }) + '\n');
} finally {
  run(['volume', 'rm', volume]);
}
