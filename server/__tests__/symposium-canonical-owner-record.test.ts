import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, chmodSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCanonicalOwnerRecorder,
  readCanonicalPrivateJson,
} from '../symposium-canonical-owner-record.js';
import type { OwnedReleasePlan } from '../symposium-owned-release.js';
import type { OriginalSymposiumControllerIdentity } from '../symposium-canonical-owner-identity.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'canonical-owner-')));
  chmodSync(root, 0o700);
  roots.push(root);
  const plan = {
    planDirectory: root,
    releaseRoot: '/private/reviewed-release',
    sourceCommit: 'a'.repeat(40),
    configSha256: 'b'.repeat(64),
    buildSha256: 'c'.repeat(64),
  } as OwnedReleasePlan;
  const identity = {
    instanceId: 'original',
    epoch: 1,
    custodianPid: process.pid,
    controllerPid: 99999,
    state: 'active',
    scope: 'fresh-retained-sessions',
  } as OriginalSymposiumControllerIdentity;
  const observe = (pid: number) => ({
    pid,
    birth: 'birth-' + pid,
    cwd: plan.releaseRoot,
    parentPid: process.pid,
  });
  return { root, plan, identity, observe };
}
it('records from the fresh original callback, refuses reopened ownership, and retains monotonic controller handoff', () => {
  const f = fixture();
  const record = createCanonicalOwnerRecorder(f.plan, f.observe);
  let checks = 0;
  record(f.identity, () => {
    checks++;
  });
  expect(checks).toBe(3);
  expect(() => createCanonicalOwnerRecorder(f.plan, f.observe)).toThrow();
  record({ ...f.identity, epoch: 2, controllerPid: 99998 }, () => {});
  expect(readCanonicalPrivateJson(join(f.root, 'original-owner.json'))).toMatchObject({
    epoch: 2,
    app: { pid: 99998 },
  });
  expect(() => record({ ...f.identity, epoch: 3, instanceId: 'successor' }, () => {})).toThrow();
});
it('refuses lost current authority and edited owner evidence', () => {
  const f = fixture();
  const record = createCanonicalOwnerRecorder(f.plan, f.observe);
  expect(() =>
    record(f.identity, () => {
      throw Error('child lost');
    }),
  ).toThrow();
  record(f.identity, () => {});
  writeFileSync(join(f.root, 'original-owner.json'), '{}');
  expect(() => record({ ...f.identity, epoch: 2 }, () => {})).toThrow();
});
