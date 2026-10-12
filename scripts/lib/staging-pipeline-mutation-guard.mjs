import process from 'node:process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  constants,
  existsSync,
  lstatSync,
  realpathSync,
  openSync,
  closeSync,
  fstatSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

function privatePipelineDatabase(root) {
  const database = join(root, 'queue.db');
  const parent = lstatSync(root);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid() ||
    parent.mode & 0o077 ||
    realpathSync(root) !== root
  )
    throw Error('Private staging pipeline reservation required');
  const fd = openSync(database, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o600 || s.nlink !== 1)
      throw Error('Private pipeline database required');
  } finally {
    closeSync(fd);
  }
  return new DatabaseSync(database, { readOnly: true });
}

/** Called by the authenticated actual stage owner before every fixture, provider
 * dispatch and finalize. A plan digest fences drift; it is never authentication,
 * account authorization, model exception approval, or cleanup proof. */
export function assertStagingPipelineFeatureDispatch(
  { sourceCommit, token, planSha256, plan },
  { root = join(homedir(), '.local/share/mitzo-staging-pipeline') } = {},
) {
  const db = privatePipelineDatabase(root); // Missing enrollment never grants feature authority.
  try {
    const row = db
      .prepare(
        `SELECT reservation.*, requests.payload,
      feature_binding.epoch AS feature_epoch, feature_binding.request_id AS feature_request,
      feature_binding.plan_sha256, feature_binding.owner_instance
      FROM reservation JOIN requests ON requests.id=reservation.request_id
      JOIN feature_binding ON feature_binding.singleton=reservation.singleton WHERE reservation.singleton=1`,
      )
      .get();
    if (
      !row ||
      !token ||
      !plan ||
      row.state !== 'active' ||
      row.dispatched !== 1 ||
      row.epoch !== token.epoch ||
      row.request_id !== token.requestId ||
      row.owner !== token.owner ||
      row.nonce !== token.nonce ||
      row.source_commit !== sourceCommit ||
      Date.now() >= row.deadline ||
      row.feature_epoch !== token.epoch ||
      row.feature_request !== token.requestId ||
      row.plan_sha256 !== planSha256 ||
      row.owner_instance !== plan.ownerInstance ||
      plan.requestId !== token.requestId ||
      plan.sourceCommit !== sourceCommit
    )
      throw Error('Exact original-owner feature reservation required');
    const request = JSON.parse(row.payload);
    if (
      request.version !== 2 ||
      request.suite !== 'profile-tools-v1' ||
      request.profileId !== plan.profileId ||
      request.enrollmentRevision !== plan.enrollmentRevision
    )
      throw Error('Immutable feature profile enrollment changed');
  } finally {
    db.close();
  }
}

/** Enrolled staging cannot be replaced by a direct operator/session command
 * while another request owns its deployment-and-test window. No DB creation,
 * recovery, expiry reclamation or deployment.lock mutation happens here. */
export function assertStagingPipelineMutation(
  { target, apply, proof },
  { root = join(homedir(), '.local/share/mitzo-staging-pipeline') } = {},
) {
  const database = join(root, 'queue.db');
  if (!existsSync(database)) return;
  const parent = lstatSync(root);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid() ||
    parent.mode & 0o077 ||
    realpathSync(root) !== root
  )
    throw Error('Private staging pipeline reservation required');
  const fd = openSync(database, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o600 || s.nlink !== 1)
      throw Error('Private pipeline database required');
  } finally {
    closeSync(fd);
  }
  if (typeof proof !== 'string' || proof.length > 2048)
    throw Error('Active staging pipeline reservation required');
  const token = JSON.parse(proof);
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    const row = db.prepare('SELECT * FROM reservation WHERE singleton=1').get();
    if (
      !row ||
      row.state !== 'active' ||
      row.epoch !== token.epoch ||
      row.request_id !== token.requestId ||
      row.owner !== token.owner ||
      row.nonce !== token.nonce ||
      row.source_commit !== target ||
      Date.now() >= row.deadline
    )
      throw Error('Exact active staging pipeline reservation required');
    if (apply && row.dispatched !== 1) throw Error('Deployment dispatch was not admitted');
  } finally {
    db.close();
  }
}
