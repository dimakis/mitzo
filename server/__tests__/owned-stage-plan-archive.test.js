import { afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  archiveCompletedOwnedPlan,
  verifyCompletedOwnedPlanArchive,
} from '../../scripts/lib/owned-stage-plan-archive.mjs';
import { hash } from '../../scripts/lib/staging-cold-audit.mjs';
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'owned-plan-archive-')));
  roots.push(root);
  const operation = '11111111-1111-4111-8111-111111111111';
  const archive = join(root, 'service/owned-updates', operation);
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  const plan = { version: 1, operation, target: 'a'.repeat(40), archive };
  const data = JSON.stringify(plan) + '\n';
  const planPath = join(root, 'service/owned-update-plan.json');
  writeFileSync(planPath, data, { mode: 0o600 });
  writeFileSync(join(archive, 'plan.json'), data, { mode: 0o600 });
  const selection = {
    operation,
    source: plan.target,
    instanceId: '22222222-2222-4222-8222-222222222222',
    epoch: 1,
    planSha256: hash(data),
    controllerSource: 'b'.repeat(40),
    controllerReceiptSha256: 'c'.repeat(64),
  };
  const proof = { currentOwner: selection.instanceId, fullCompletion: true };
  return { root, archive, planPath, selection, proof, verify: async () => proof };
}
it('archives only the exact completed plan after repeated original-current-owner proof, retaining private intent and receipt', async () => {
  const f = fixture();
  let calls = 0;
  const result = await archiveCompletedOwnedPlan(f.root, f.selection, async () => {
    calls++;
    return f.proof;
  });
  expect(calls).toBe(3);
  expect(result.archived).toBe(true);
  expect(existsSync(f.planPath)).toBe(false);
  expect(readFileSync(join(f.archive, 'completed-plan.json'), 'utf8')).toBe(
    readFileSync(join(f.archive, 'plan.json'), 'utf8'),
  );
  expect(existsSync(join(f.archive, 'completed-plan-receipt.json'))).toBe(true);
  expect(existsSync(join(f.root, 'service/deployment.lock'))).toBe(false);
});
it.each([
  'missing-proof',
  'changed-owner',
  'changed-plan',
  'foreign-lock',
  'lock-drift',
  'checkpoint-drift',
  'no-clobber',
  'symlink',
])('refuses %s without losing original plan or another operation lock', async (failure) => {
  const f = fixture();
  let calls = 0;
  const lock = join(f.root, 'service/deployment.lock');
  if (failure === 'foreign-lock') writeFileSync(lock, 'foreign', { mode: 0o600 });
  if (failure === 'no-clobber')
    writeFileSync(join(f.archive, 'completed-plan.json'), 'prior evidence', { mode: 0o600 });
  if (failure === 'symlink') {
    rmSync(f.planPath);
    symlinkSync(join(f.archive, 'plan.json'), f.planPath);
  }
  const verify = async () => {
    calls++;
    if (failure === 'missing-proof') throw Error('missing real completion');
    if (calls === 2 && failure === 'changed-owner') return { ...f.proof, currentOwner: 'foreign' };
    if (calls === 2 && failure === 'lock-drift') writeFileSync(lock, 'foreign replacement');
    if (calls === 2 && failure === 'checkpoint-drift')
      writeFileSync(join(f.archive, 'completed-plan-intent.json'), 'changed checkpoint');
    if (calls === 2 && failure === 'changed-plan') writeFileSync(f.planPath, 'changed plan');
    return f.proof;
  };
  await expect(archiveCompletedOwnedPlan(f.root, f.selection, verify)).rejects.toThrow();
  expect(existsSync(f.planPath)).toBe(true);
  if (failure === 'foreign-lock') expect(readFileSync(lock, 'utf8')).toBe('foreign');
  if (failure === 'lock-drift') expect(readFileSync(lock, 'utf8')).toBe('foreign replacement');
  if (failure === 'checkpoint-drift') expect(existsSync(lock)).toBe(false);
  if (failure === 'changed-plan') expect(existsSync(lock)).toBe(true);
  if (failure === 'missing-proof' || failure === 'changed-owner' || failure === 'no-clobber')
    expect(existsSync(lock)).toBe(false);
});
it('retains the exact metadata lock after disposition uncertainty and verifies that same operation without another disposition', async () => {
  const f = fixture();
  let calls = 0;
  await expect(
    archiveCompletedOwnedPlan(f.root, f.selection, async () => {
      if (++calls === 3) throw Error('lost completion acknowledgement');
      return f.proof;
    }),
  ).rejects.toThrow('acknowledgement');
  expect(existsSync(f.planPath)).toBe(false);
  expect(existsSync(join(f.root, 'service/deployment.lock'))).toBe(true);
  expect(
    (await verifyCompletedOwnedPlanArchive(f.root, f.selection, f.verify)).verificationOnly,
  ).toBe(true);
  expect(existsSync(join(f.root, 'service/deployment.lock'))).toBe(false);
});
it('verification refuses a different plan, tampered evidence or foreign selection and retains uncertainty', async () => {
  const f = fixture();
  let calls = 0;
  await expect(
    archiveCompletedOwnedPlan(f.root, f.selection, async () => {
      if (++calls === 3) throw Error('lost ack');
      return f.proof;
    }),
  ).rejects.toThrow();
  writeFileSync(f.planPath, 'new unrelated plan', { mode: 0o600 });
  await expect(verifyCompletedOwnedPlanArchive(f.root, f.selection, f.verify)).rejects.toThrow();
  expect(readFileSync(f.planPath, 'utf8')).toBe('new unrelated plan');
  expect(existsSync(join(f.root, 'service/deployment.lock'))).toBe(true);
  rmSync(f.planPath);
  await expect(
    verifyCompletedOwnedPlanArchive(
      f.root,
      { ...f.selection, instanceId: '33333333-3333-4333-8333-333333333333' },
      f.verify,
    ),
  ).rejects.toThrow();
  writeFileSync(join(f.archive, 'completed-plan.json'), 'tampered');
  await expect(verifyCompletedOwnedPlanArchive(f.root, f.selection, f.verify)).rejects.toThrow();
  expect(existsSync(join(f.root, 'service/deployment.lock'))).toBe(true);
});
it('uses a qualified newer accepted verifier without rewriting the original intent or repeating disposition', async () => {
  const f = fixture();
  let calls = 0;
  await expect(
    archiveCompletedOwnedPlan(f.root, f.selection, async () => {
      if (++calls === 3) throw Error('lost ack');
      return f.proof;
    }),
  ).rejects.toThrow();
  const oldIntent = readFileSync(join(f.archive, 'completed-plan-intent.json'), 'utf8');
  const newer = {
    ...f.selection,
    controllerSource: 'd'.repeat(40),
    controllerReceiptSha256: 'e'.repeat(64),
  };
  let qualified = false;
  const qualification = {
    version: 1,
    originalControllerSource: f.selection.controllerSource,
    originalControllerReceiptSha256: f.selection.controllerReceiptSha256,
    originalControllerTree: '1'.repeat(40),
    verifierSource: newer.controllerSource,
    verifierReceiptSha256: newer.controllerReceiptSha256,
    verifierTree: '2'.repeat(40),
  };
  const result = await verifyCompletedOwnedPlanArchive(
    f.root,
    newer,
    f.verify,
    async (old, current) => {
      expect(old).toEqual(f.selection);
      expect(current).toEqual(newer);
      qualified = true;
      return qualification;
    },
  );
  expect(result.verificationOnly).toBe(true);
  expect(qualified).toBe(true);
  expect(readFileSync(join(f.archive, 'completed-plan-intent.json'), 'utf8')).toBe(oldIntent);
  expect(existsSync(f.planPath)).toBe(false);
  expect(
    JSON.parse(
      readFileSync(
        join(f.archive, `completed-plan-verification-${newer.controllerSource}.json`),
        'utf8',
      ),
    ).verifier,
  ).toEqual(qualification);
});
it('keeps an interrupted metadata lock when a newer verifier lacks historical authority', async () => {
  const f = fixture();
  let calls = 0;
  await expect(
    archiveCompletedOwnedPlan(f.root, f.selection, async () => {
      if (++calls === 3) throw Error('lost ack');
      return f.proof;
    }),
  ).rejects.toThrow();
  const newer = {
    ...f.selection,
    controllerSource: 'd'.repeat(40),
    controllerReceiptSha256: 'e'.repeat(64),
  };
  await expect(verifyCompletedOwnedPlanArchive(f.root, newer, f.verify)).rejects.toThrow();
  await expect(
    verifyCompletedOwnedPlanArchive(f.root, newer, f.verify, async () => {
      throw Error('unaccepted/unrelated controller');
    }),
  ).rejects.toThrow();
  expect(existsSync(join(f.root, 'service/deployment.lock'))).toBe(true);
});
it.each(['completed-plan.json', 'completed-plan-intent.json'])(
  'retains uncertainty if %s changes during post-disposition verification',
  async (name) => {
    const f = fixture();
    let calls = 0;
    await expect(
      archiveCompletedOwnedPlan(f.root, f.selection, async () => {
        if (++calls === 3)
          writeFileSync(join(f.archive, name), 'tampered during current-owner read');
        return f.proof;
      }),
    ).rejects.toThrow();
    expect(existsSync(f.planPath)).toBe(false);
    expect(existsSync(join(f.root, 'service/deployment.lock'))).toBe(true);
  },
);
