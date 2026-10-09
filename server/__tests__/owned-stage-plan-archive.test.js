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
  lstatSync,
  linkSync,
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
async function leavePreparedRetry(f) {
  let calls = 0;
  await expect(
    archiveCompletedOwnedPlan(f.root, f.selection, async () => {
      if (++calls === 2) throw Error('transient current-owner observation');
      return f.proof;
    }),
  ).rejects.toThrow('transient');
  expect(existsSync(f.planPath)).toBe(true);
  expect(existsSync(join(f.root, 'service/deployment.lock'))).toBe(false);
}
it('retries an unchanged original pre-disposition checkpoint without replacing its evidence', async () => {
  const f = fixture();
  await leavePreparedRetry(f);
  const paths = ['completed-plan.json', 'completed-plan-intent.json'].map((name) =>
    join(f.archive, name),
  );
  const saved = paths.map((path) => ({ bytes: readFileSync(path), ino: lstatSync(path).ino }));
  expect((await archiveCompletedOwnedPlan(f.root, f.selection, f.verify)).archived).toBe(true);
  for (let i = 0; i < paths.length; i++) {
    expect(readFileSync(paths[i])).toEqual(saved[i].bytes);
    expect(lstatSync(paths[i]).ino).toBe(saved[i].ino);
  }
  expect(existsSync(f.planPath)).toBe(false);
});
it('reuses an exact copied plan when initial intent creation was interrupted', async () => {
  const f = fixture();
  writeFileSync(join(f.archive, 'completed-plan.json'), readFileSync(f.planPath), { mode: 0o600 });
  const ino = lstatSync(join(f.archive, 'completed-plan.json')).ino;
  expect((await archiveCompletedOwnedPlan(f.root, f.selection, f.verify)).archived).toBe(true);
  expect(lstatSync(join(f.archive, 'completed-plan.json')).ino).toBe(ino);
});
it('qualifies a newer accepted controller for retry while preserving the original disposition selection', async () => {
  const f = fixture();
  await leavePreparedRetry(f);
  const oldIntent = readFileSync(join(f.archive, 'completed-plan-intent.json'));
  const newer = {
    ...f.selection,
    controllerSource: 'd'.repeat(40),
    controllerReceiptSha256: 'e'.repeat(64),
  };
  const qualification = {
    version: 1,
    originalControllerSource: f.selection.controllerSource,
    originalControllerReceiptSha256: f.selection.controllerReceiptSha256,
    originalControllerTree: '1'.repeat(40),
    verifierSource: newer.controllerSource,
    verifierReceiptSha256: newer.controllerReceiptSha256,
    verifierTree: '2'.repeat(40),
  };
  let calls = 0;
  expect(
    (
      await archiveCompletedOwnedPlan(f.root, newer, f.verify, async (old, current) => {
        calls++;
        expect(old).toEqual(f.selection);
        expect(current).toEqual(newer);
        return qualification;
      })
    ).archived,
  ).toBe(true);
  expect(calls).toBeGreaterThanOrEqual(2);
  expect(readFileSync(join(f.archive, 'completed-plan-intent.json'))).toEqual(oldIntent);
  expect(
    JSON.parse(readFileSync(join(f.archive, 'completed-plan-receipt.json'))).selection,
  ).toEqual(f.selection);
  expect(
    JSON.parse(
      readFileSync(
        join(f.archive, 'completed-plan-verification-' + newer.controllerSource + '.json'),
      ),
    ).verifier,
  ).toEqual(qualification);
});
it.each([
  'owner',
  'intent',
  'copy',
  'copy-symlink',
  'copy-hardlink',
  'intent-only',
  'foreign-receipt',
  'unqualified-controller',
])('refuses %s retry drift without vacating the original plan', async (failure) => {
  const f = fixture();
  await leavePreparedRetry(f);
  const copy = join(f.archive, 'completed-plan.json'),
    intent = join(f.archive, 'completed-plan-intent.json');
  if (failure === 'intent') {
    const value = JSON.parse(readFileSync(intent));
    value.selection.epoch++;
    writeFileSync(intent, JSON.stringify(value));
  }
  if (failure === 'copy') writeFileSync(copy, 'changed');
  if (failure === 'copy-symlink') {
    rmSync(copy);
    symlinkSync(f.planPath, copy);
  }
  if (failure === 'copy-hardlink') {
    rmSync(copy);
    linkSync(f.planPath, copy);
  }
  if (failure === 'intent-only') rmSync(copy);
  if (failure === 'foreign-receipt')
    writeFileSync(join(f.archive, 'completed-plan-receipt.json'), '{}', { mode: 0o600 });
  const selection =
    failure === 'unqualified-controller'
      ? {
          ...f.selection,
          controllerSource: 'd'.repeat(40),
          controllerReceiptSha256: 'e'.repeat(64),
        }
      : f.selection;
  await expect(
    archiveCompletedOwnedPlan(f.root, selection, async () =>
      failure === 'owner' ? { ...f.proof, currentOwner: 'foreign' } : f.proof,
    ),
  ).rejects.toThrow();
  expect(existsSync(f.planPath)).toBe(true);
});
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
