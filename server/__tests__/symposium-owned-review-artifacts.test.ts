import Database from 'better-sqlite3';
import type { CompletedArtifactSeal } from '../symposium-physical-artifact-seal.js';
import { canonicalReviewJson } from '../symposium-review-records.js';
import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOwnedReviewArtifactResults } from '../symposium-owned-review-artifacts.js';

it('retains an exact physical seal result and recovers it without model output', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'owned-review-artifact-'));
  try {
    const seal = {
      kind: 'completed_artifact_seal',
      version: 1,
      fenceId: 'fence',
      sessionId: 'session',
      custodyDigest: 'a'.repeat(64),
      intentDigest: 'b'.repeat(64),
      retentionDigest: 'c'.repeat(64),
      revocationDigest: 'd'.repeat(64),
      repositoryPath: '.',
      git: {
        version: 1,
        commit: 'e'.repeat(40),
        tree: 'f'.repeat(40),
        entries: 1,
        bytes: 2,
        manifestDigest: '1'.repeat(64),
        committedTreeDigest: '2'.repeat(64),
      },
      verifier: { id: '3'.repeat(64), image: 'image', codeDigest: '4'.repeat(64) },
      completedAt: 60,
    } as const;
    const completion = {
      attempt: {
        workflowId: 'workflow',
        attemptId: 'attempt',
        policyReservationId: 'reservation',
        kind: 'initial',
        actorSeatId: 'coder',
        artifactRevision: 'base',
        artifactHash: '5'.repeat(64),
        binding: {
          claimToken: 'claim',
          deliveryId: 'delivery',
          membershipGeneration: 1,
          configRevision: 1,
        },
      },
      execution: {
        deliveryId: 'delivery',
        seatId: 'coder',
        claimToken: 'claim',
        status: 'delivered',
        providerThreadId: 'thread',
        providerTurnId: 'turn',
        completedAt: 50,
      },
      observation: {
        status: 'completed',
        terminalAt: 50,
        terminalConflict: false,
        identity: {
          claimToken: 'claim',
          sessionId: 'session',
          seatId: 'coder',
          providerThreadId: 'thread',
          providerTurnId: 'turn',
        },
      },
    };
    const sealCompleted = vi.fn(async () => ({
      seal,
      claimToken: 'claim',
      operationId: '{"thread":"thread","turn":"turn"}',
    }));
    const deps = {
      sealCompleted,
      sealByFence: vi.fn(async () => seal),
      sealIntent: () => ({
        fenceId: 'fence',
        selection: { sessionId: 'session', artifact: { volumeGeneration: 'generation' } },
        capturedAt: 55,
      }),
      volumeGeneration: () => 'generation',
    };
    const owner = createOwnedReviewArtifactResults(join(directory, 'custody.db'), deps);
    expect(owner.currentOrNull({ owner: 'owner', sessionId: 'session' })).toBeNull();
    await owner.refresh({ owner: 'owner', sessionId: 'session' }, completion as never);
    expect(
      owner.result({ owner: 'owner', sessionId: 'session' }, completion as never),
    ).toMatchObject({
      attemptId: 'attempt',
      inputRevision: 'base',
      artifactRevision: seal.git.commit,
      artifactHash: seal.git.committedTreeDigest,
    });
    owner.close();
    const recovered = createOwnedReviewArtifactResults(join(directory, 'custody.db'), deps);
    expect(recovered.current({ owner: 'owner', sessionId: 'session' })).toEqual({
      revision: seal.git.commit,
      hash: seal.git.committedTreeDigest,
    });
    expect(
      recovered.currentFence(
        { owner: 'owner', sessionId: 'session' },
        {
          revision: seal.git.commit,
          hash: seal.git.committedTreeDigest,
        },
      ),
    ).toBe('fence');
    expect(() =>
      recovered.currentFence(
        { owner: 'owner', sessionId: 'session' },
        {
          revision: 'another',
          hash: seal.git.committedTreeDigest,
        },
      ),
    ).toThrow('Current artifact');
    recovered.close();
    expect(sealCompleted).toHaveBeenCalledOnce();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it('retains the exact delta source after a second fix and rejects ambiguous or changed bindings', async () => {
  // Offline receipt transport; the owner/journal are real, no model or physical proof invented.
  const directory = mkdtempSync(join(tmpdir(), 'owned-review-history-'));
  const path = join(directory, 'results.db');
  const context = { owner: 'user', sessionId: 'session' };
  const hash = (value: unknown) =>
    createHash('sha256').update(canonicalReviewJson(value)).digest('hex');
  const seals = new Map<string, CompletedArtifactSeal>();
  let active!: CompletedArtifactSeal;
  const ownerDeps: Parameters<typeof createOwnedReviewArtifactResults>[1] = {
    sealCompleted: async (_context, completion) => ({
      seal: active,
      claimToken: completion.attempt.binding.claimToken,
      operationId: JSON.stringify({ thread: 'thread', turn: completion.attempt.attemptId }),
    }),
    sealByFence: async (fence) => seals.get(fence)!,
    sealIntent: (fence) => ({
      fenceId: fence,
      capturedAt: 10,
      selection: { sessionId: 'session', artifact: { volumeGeneration: 'generation' } },
    }),
    volumeGeneration: () => 'generation',
  };
  const owner = createOwnedReviewArtifactResults(path, ownerDeps);
  try {
    for (const [index, kind] of ['initial', 'fix', 'fix'].entries()) {
      const id = ['initial', 'fix1', 'fix2'][index];
      active = {
        kind: 'completed_artifact_seal',
        version: 1,
        sessionId: 'session',
        fenceId: id,
        git: {
          commit: String(index + 1).repeat(40),
          committedTreeDigest: String(index + 2).repeat(64),
        },
        completedAt: 20 + index,
      } as unknown as CompletedArtifactSeal;
      seals.set(id, active);
      const completion = {
        attempt: {
          workflowId: 'workflow',
          attemptId: id,
          kind,
          actorSeatId: 'coder',
          artifactRevision: 'source',
          artifactHash: 'a'.repeat(64),
          binding: { claimToken: id, deliveryId: id },
        },
        execution: {
          completedAt: 5,
          status: 'delivered',
          claimToken: id,
          deliveryId: id,
          seatId: 'coder',
          providerThreadId: 'thread',
          providerTurnId: id,
        },
        observation: {
          status: 'completed',
          terminalConflict: false,
          terminalAt: 5,
          identity: {
            sessionId: 'session',
            claimToken: id,
            seatId: 'coder',
            providerThreadId: 'thread',
            providerTurnId: id,
          },
        },
      };
      await owner.refresh(context, completion as unknown as Parameters<typeof owner.refresh>[1]);
    }
    const source = {
      workflowId: 'workflow',
      artifactRevision: '2'.repeat(40),
      artifactHash: '3'.repeat(64),
      fenceId: 'fix1',
    };
    const delta1 = owner.completedSourceResult(context, source);
    expect(delta1).toMatchObject({
      attemptId: 'fix1',
      artifactRevision: source.artifactRevision,
      sealDigest: hash(seals.get('fix1')),
    });
    expect(owner.currentResult(context)?.attemptId).toBe('fix2');
    expect(owner.completedSourceResult(context, { ...source, fenceId: 'fix2' })).toBeNull();
    expect(owner.completedSourceResult({ ...context, sessionId: 'other' }, source)).toBeNull();
    const db = new Database(path);
    db.prepare(
      "UPDATE symposium_review_artifact_results SET claim_token='changed' WHERE attempt_id='fix1'",
    ).run();
    expect(() => owner.completedSourceResult(context, source)).toThrow(
      'Historical completed source binding changed',
    );
    db.prepare(
      "UPDATE symposium_review_artifact_results SET claim_token='fix1' WHERE attempt_id='fix1'",
    ).run();
    db.exec(
      "ALTER TABLE symposium_review_artifact_results RENAME TO retained_original; CREATE TABLE symposium_review_artifact_results AS SELECT * FROM retained_original; INSERT INTO symposium_review_artifact_results SELECT * FROM retained_original WHERE attempt_id='fix1'",
    );
    expect(() => owner.completedSourceResult(context, source)).toThrow(
      'Historical completed source is ambiguous',
    );
    db.close();
  } finally {
    owner.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
