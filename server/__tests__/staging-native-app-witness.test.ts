import { expect, it, vi } from 'vitest';
import {
  createOriginalStagingAppSourceWitness,
  captureOriginalStagingAppSource,
} from '../staging-native-app-witness.js';
const native = 'a'.repeat(40),
  app = 'b'.repeat(40),
  owner = 'original';
function fixture() {
  const capture = vi.fn(() =>
    Object.freeze({
      nativeSourceCommit: native,
      acceptedAppCommit: app,
      appRoot: '/private/stage/releases/' + app.slice(0, 12),
      instanceId: owner,
      custodianPid: process.pid,
      epoch: 2,
      controllerPid: process.pid + 1,
      compatibilitySha256: 'c'.repeat(64),
    }),
  );
  const witness = createOriginalStagingAppSourceWitness(capture);
  return { capture, witness };
}
it('requires the original same-process witness, keeps native source separate and rechecks live capture', () => {
  const f = fixture();
  const result = captureOriginalStagingAppSource(f.witness, native, owner);
  expect(result.nativeSourceCommit).toBe(native);
  expect(result.acceptedAppCommit).toBe(app);
  expect(f.capture).toHaveBeenCalledOnce();
  expect(() =>
    captureOriginalStagingAppSource(JSON.parse(JSON.stringify(f.witness)), native, owner),
  ).toThrow('witness');
  expect(() => captureOriginalStagingAppSource(f.witness, app, owner)).toThrow('witness');
  f.capture.mockImplementation(() => {
    throw Error('actual child lost');
  });
  expect(() => captureOriginalStagingAppSource(f.witness, native, owner)).toThrow(
    'actual child lost',
  );
});
it('refuses async, false, malformed and changed original source/owner observations', () => {
  for (const capture of [() => false, async () => ({}), () => ({ nativeSourceCommit: native })]) {
    const witness = createOriginalStagingAppSourceWitness(capture as never);
    expect(() => captureOriginalStagingAppSource(witness, native, owner)).toThrow('witness');
  }
  const f = fixture();
  expect(() => captureOriginalStagingAppSource(f.witness, native, 'replacement')).toThrow(
    'witness',
  );
});
