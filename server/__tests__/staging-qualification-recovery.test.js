import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { verifyRetainedQualification } from '../../scripts/lib/staging-qualification-recovery.mjs';

function fixture() {
  const root = '/private/stage',
    operation = '12345678-1234-1234-1234-123456789abc';
  const prior = {
    sourceCommit: 'a'.repeat(40),
    dependencyFingerprint: 'b'.repeat(64),
    compiledArtifacts: { 'dist/index.js': 'c'.repeat(64) },
  };
  const priorBytes = Buffer.from(JSON.stringify(prior, null, 2) + '\n');
  const hash = (b) => createHash('sha256').update(b).digest('hex');
  const snapshot = {
    version: 1,
    sourceCommit: prior.sourceCommit,
    originalReceiptSha256: hash(priorBytes),
    closureFingerprint: 'd'.repeat(64),
  };
  const auditSha256 = hash(JSON.stringify(snapshot));
  const currentBytes = Buffer.from(
    JSON.stringify({ ...prior, dependencyFingerprint: snapshot.closureFingerprint }, null, 2) +
      '\n',
  );
  const lock = {
    id: operation,
    mode: 'legacy-qualification',
    expected: prior.sourceCommit,
    controller: 'e'.repeat(40),
  };
  const qualification = {
    ...snapshot,
    controllerSource: lock.controller,
    auditSha256,
    archive: root + '/service/requalifications/' + operation,
    resultingReceiptSha256: hash(currentBytes),
  };
  return { root, operation, auditSha256, lock, qualification, snapshot, priorBytes, currentBytes };
}
it('accepts only the exact completed metadata from the retained original operation', () => {
  const f = fixture();
  expect(verifyRetainedQualification(f)).toEqual(JSON.parse(f.priorBytes));
});
it('refuses another operation, source controller, archive path, or audit pin', () => {
  for (const patch of [
    { operation: '22345678-1234-1234-1234-123456789abc' },
    { auditSha256: 'f'.repeat(64) },
    { lock: { ...fixture().lock, mode: 'ordinary-to-owned' } },
    { qualification: { ...fixture().qualification, controllerSource: 'f'.repeat(40) } },
    { qualification: { ...fixture().qualification, archive: '/outside' } },
  ])
    expect(() => verifyRetainedQualification({ ...fixture(), ...patch })).toThrow();
});
it('refuses partial migration, changed old evidence, and unrelated metadata rewrites', () => {
  const f = fixture();
  expect(() => verifyRetainedQualification({ ...f, currentBytes: f.priorBytes })).toThrow();
  expect(() => verifyRetainedQualification({ ...f, priorBytes: Buffer.from('{}') })).toThrow();
  const changed = Buffer.from(
    JSON.stringify({ ...JSON.parse(f.currentBytes), sourceCommit: 'f'.repeat(40) }, null, 2) + '\n',
  );
  expect(() =>
    verifyRetainedQualification({
      ...f,
      currentBytes: changed,
      qualification: {
        ...f.qualification,
        resultingReceiptSha256: createHash('sha256').update(changed).digest('hex'),
      },
    }),
  ).toThrow();
});
