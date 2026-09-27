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
    recovered.close();
    expect(sealCompleted).toHaveBeenCalledOnce();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
