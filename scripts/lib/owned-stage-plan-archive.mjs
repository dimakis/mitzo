import { dirname, join } from 'node:path';
import { lstatSync, unlinkSync } from 'node:fs';
import { z } from 'zod';
import { MetadataVerifierQualification } from './owned-stage-plan-verifier.mjs';
import { bytes, hash, directory } from './staging-cold-audit.mjs';
import { privateJson, replacePrivateJson } from './staging-files.mjs';
import { exclusive, sync } from './staging-cold-prepare.mjs';
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const CompletedPlanSelection = z.strictObject({
  operation: z.string().uuid(),
  source: z.string().regex(/^[a-f0-9]{40}$/),
  instanceId: z.string().uuid(),
  epoch: z.number().int().positive().safe(),
  planSha256: sha,
  controllerSource: z.string().regex(/^[a-f0-9]{40}$/),
  controllerReceiptSha256: sha,
});
const Lock = z.strictObject({
  version: z.literal(1),
  id: z.string().uuid(),
  mode: z.literal('completed-owned-plan-archive'),
  selection: CompletedPlanSelection,
  originalPlan: z.strictObject({
    dev: z.number().int().nonnegative(),
    ino: z.number().int().nonnegative(),
    size: z.number().int().nonnegative(),
    sha256: sha,
  }),
  intentSha256: sha.optional(),
});
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function context(root, raw) {
  const selection = CompletedPlanSelection.parse(raw);
  const archive = join(root, 'service/owned-updates', selection.operation);
  for (const path of [root, join(root, 'service'), join(root, 'service/owned-updates'), archive])
    directory(path);
  return {
    selection,
    archive,
    planPath: join(root, 'service/owned-update-plan.json'),
    lockPath: join(root, 'service/deployment.lock'),
    copyPath: join(archive, 'completed-plan.json'),
    intentPath: join(archive, 'completed-plan-intent.json'),
    receiptPath: join(archive, 'completed-plan-receipt.json'),
  };
}
function readPlan(c, path) {
  const plan = privateJson(path),
    content = bytes(path);
  if (
    hash(content) !== c.selection.planSha256 ||
    plan.version !== 1 ||
    plan.operation !== c.selection.operation ||
    plan.target !== c.selection.source ||
    plan.archive !== c.archive
  )
    throw Error('Exact completed update plan required');
  if (!content.equals(bytes(join(c.archive, 'plan.json'))))
    throw Error('Original archived plan changed');
  return plan;
}
function identity(path) {
  privateJson(path);
  const s = lstatSync(path);
  return { dev: s.dev, ino: s.ino, size: s.size, sha256: hash(bytes(path)) };
}
function ownLock(c, lock) {
  if (!same(privateJson(c.lockPath), lock)) throw Error('Exact metadata operation lock changed');
}
function unchangedPlan(c, original) {
  if (!same(identity(c.planPath), original)) throw Error('Original completed plan changed');
}
function release(c, lock) {
  ownLock(c, lock);
  unlinkSync(c.lockPath);
  sync(dirname(c.lockPath));
}
async function complete(c, lock, verify, verifier, assertVerifier) {
  ownLock(c, lock);
  if (lstatSync(c.planPath, { throwIfNoEntry: false }))
    throw Error('Plan path is not vacant; retain metadata lock');
  const plan = readPlan(c, c.copyPath),
    intent = privateJson(c.intentPath);
  if (
    hash(bytes(c.intentPath)) !== lock.intentSha256 ||
    !same(intent.selection, c.selection) ||
    intent.planSha256 !== c.selection.planSha256 ||
    !same(intent.originalPlan, lock.originalPlan)
  )
    throw Error('Exact completed-plan disposition checkpoint changed');
  const proof = await verify(plan, c.selection, bytes(c.copyPath));
  ownLock(c, lock);
  if (!same(proof, intent.proof) || lstatSync(c.planPath, { throwIfNoEntry: false }))
    throw Error('Current completion proof changed; retain metadata lock');
  if (assertVerifier) await assertVerifier();
  ownLock(c, lock);
  readPlan(c, c.copyPath);
  if (
    hash(bytes(c.intentPath)) !== lock.intentSha256 ||
    !same(privateJson(c.intentPath), intent) ||
    lstatSync(c.planPath, { throwIfNoEntry: false })
  )
    throw Error('Completed-plan evidence changed during current-owner verification');
  const value = {
    version: 1,
    operation: c.selection.operation,
    selection: c.selection,
    intentSha256: lock.intentSha256,
    archivedPlanSha256: c.selection.planSha256,
    proof,
  };
  if (lstatSync(c.receiptPath, { throwIfNoEntry: false })) {
    if (!same(privateJson(c.receiptPath), value))
      throw Error('Completed-plan acknowledgement differs');
  } else exclusive(c.receiptPath, JSON.stringify(value) + '\n');
  ownLock(c, lock);
  if (!same(privateJson(c.receiptPath), value))
    throw Error('Completed-plan acknowledgement changed');
  if (verifier) {
    const verificationPath = join(
      c.archive,
      'completed-plan-verification-' + verifier.verifierSource + '.json',
    );
    const acknowledgement = {
      version: 1,
      operation: c.selection.operation,
      intentSha256: lock.intentSha256,
      archivedPlanSha256: c.selection.planSha256,
      verifier,
      proof,
    };
    if (lstatSync(verificationPath, { throwIfNoEntry: false })) {
      if (!same(privateJson(verificationPath), acknowledgement))
        throw Error('Metadata verifier acknowledgement differs');
    } else exclusive(verificationPath, JSON.stringify(acknowledgement) + '\n');
  }
  release(c, lock);
  return {
    archived: true,
    operation: c.selection.operation,
    source: c.selection.source,
    planSha256: c.selection.planSha256,
    serviceControl: false,
    modelCalls: 0,
    productionActions: [],
  };
}
/** Verification is a constructor-owned actual-current-owner/full-history observer,
 * never caller JSON authority. Only this exact completed plan is disposed. */
export async function archiveCompletedOwnedPlan(root, raw, verify) {
  const c = context(root, raw),
    plan = readPlan(c, c.planPath),
    original = identity(c.planPath);
  if (typeof verify !== 'function') throw Error('Actual completion observer required');
  const lock = {
    version: 1,
    id: c.selection.operation,
    mode: 'completed-owned-plan-archive',
    selection: c.selection,
    originalPlan: original,
  };
  exclusive(c.lockPath, JSON.stringify(lock) + '\n');
  let dispositionAttempted = false;
  try {
    const proof = await verify(plan, c.selection, bytes(c.planPath));
    if (!proof || typeof proof !== 'object') throw Error('Actual completion proof required');
    ownLock(c, lock);
    unchangedPlan(c, original);
    exclusive(c.copyPath, bytes(c.planPath));
    readPlan(c, c.copyPath);
    const intent = {
      version: 1,
      selection: c.selection,
      originalPlan: original,
      planSha256: c.selection.planSha256,
      proof,
    };
    exclusive(c.intentPath, JSON.stringify(intent) + '\n');
    ownLock(c, lock);
    const next = { ...lock, intentSha256: hash(bytes(c.intentPath)) };
    replacePrivateJson(c.lockPath, next);
    Object.assign(lock, next);
    if (!same(await verify(plan, c.selection, bytes(c.planPath)), proof))
      throw Error('Actual current owner changed before plan disposition');
    ownLock(c, lock);
    unchangedPlan(c, original);
    readPlan(c, c.copyPath);
    if (hash(bytes(c.intentPath)) !== lock.intentSha256)
      throw Error('Completed-plan checkpoint changed');
    dispositionAttempted = true;
    unlinkSync(c.planPath);
    sync(join(root, 'service'));
    return await complete(c, lock, verify);
  } catch (error) {
    if (!dispositionAttempted) {
      // Another plan/lock, uncertain bytes or any alias never grants release.
      try {
        ownLock(c, lock);
        unchangedPlan(c, original);
        release(c, lock);
      } catch {
        /* Retain uncertain metadata operation. */
      }
    }
    throw error;
  }
}
/** Same operation only: this never repeats plan disposition or any service effect. */
export async function verifyCompletedOwnedPlanArchive(root, raw, verify, qualifyVerifier) {
  const requested = context(root, raw),
    lock = Lock.parse(privateJson(requested.lockPath));
  const normalized = {
    ...requested.selection,
    controllerSource: lock.selection.controllerSource,
    controllerReceiptSha256: lock.selection.controllerReceiptSha256,
  };
  if (
    lock.id !== requested.selection.operation ||
    !same(normalized, lock.selection) ||
    !lock.intentSha256
  )
    throw Error('Exact interrupted completed-plan metadata operation required');
  if (!same(requested.selection, lock.selection) && typeof qualifyVerifier !== 'function')
    throw Error('New metadata verifier requires original-controller accepted-history proof');
  let verifier;
  if (qualifyVerifier) {
    verifier = MetadataVerifierQualification.parse(
      await qualifyVerifier(lock.selection, requested.selection),
    );
    if (
      verifier.originalControllerSource !== lock.selection.controllerSource ||
      verifier.originalControllerReceiptSha256 !== lock.selection.controllerReceiptSha256 ||
      verifier.verifierSource !== requested.selection.controllerSource ||
      verifier.verifierReceiptSha256 !== requested.selection.controllerReceiptSha256
    )
      throw Error('Metadata verifier substituted original authority');
  }
  const c = context(root, lock.selection);
  ownLock(c, lock);
  const result = await complete(
    c,
    lock,
    verify,
    verifier,
    qualifyVerifier
      ? async () => {
          const repeated = MetadataVerifierQualification.parse(
            await qualifyVerifier(lock.selection, requested.selection),
          );
          if (!same(repeated, verifier))
            throw Error('Original/current metadata verifier qualification changed');
        }
      : undefined,
  );
  return { ...result, verificationOnly: true };
}
