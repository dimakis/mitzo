import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  buildPermissionHandler,
  getPendingTelosSourceReview,
  registerPending,
  removePending,
  resolvePending,
} from '@mitzo/harness';
import { createTelosSourceApprovalData } from './fixtures/telos-source-approval-data.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close());
});

async function selected(kind: 'create' | 'adopt') {
  const f = createTelosSourceApprovalData();
  cleanup.push(() => f.close());
  const permission = await f.request({ kind, marker: 'native' });
  const permId = String(permission.permId);
  cleanup.push(() => removePending(permId));
  const proof = getPendingTelosSourceReview(permId, 'planning')!;
  const review = await f.service.review(permId, 'planning', f.actor);
  const message = review.messages.find((message) => message.messageId === 'approved')!;
  const input = {
    sessionId: 'planning',
    requestId: randomUUID(),
    proposalSha256: review.proposalSha256,
    selection: {
      mode: 'selected' as const,
      boundary: { sequence: message.sequence, messageId: message.messageId },
      messageIds: [message.messageId],
      artifacts: [],
    },
  };
  return { f, permId, proof, input };
}

function expectNoApprovalWrites(f: ReturnType<typeof createTelosSourceApprovalData>) {
  expect(f.counts()).toMatchObject({ canonicalCreates: 0, allocations: 0, sources: { total: 0 } });
  const db = new Database(f.dbPath);
  try {
    expect(db.prepare('SELECT COUNT(*) AS total FROM telos_work_source_approvals').get()).toEqual({
      total: 0,
    });
  } finally {
    db.close();
  }
}

it.each([
  ['create', 'compile'],
  ['adopt', 'compile'],
  ['create', 'prepare'],
  ['adopt', 'prepare'],
] as const)(
  'refuses a replaced %s host invocation at the %s boundary before preparing or mutating',
  async (kind, boundary) => {
    const { f, permId, proof, input } = await selected(kind);
    const preview = await f.service.preview(permId, input, f.actor);
    const replace = () =>
      registerPending(
        permId,
        proof.toolName,
        vi.fn(),
        kind === 'create'
          ? { ...proof.toolInput, summary: 'A different unreviewed outcome' }
          : { itemId: 'another-unreviewed-item' },
        undefined,
        proof.sessionId,
        {
          permId,
          sessionId: proof.sessionId,
          toolName: proof.toolName,
          toolInput: 'Replacement host proposal',
          reviewKind: 'telos_source',
          expiresAt: proof.expiresAt + 1,
        },
        { toolUseId: proof.toolUseId + '-replacement' },
      );
    const changePending = () => {
      if (boundary === 'compile') replace();
      // compile's continuation runs between these microtasks; the replacement
      // then arrives before approve's continuation may prepare consent.
      else queueMicrotask(() => queueMicrotask(replace));
    };
    if (kind === 'create') {
      const actual = f.service.capture.previewNew.bind(f.service.capture);
      vi.spyOn(f.service.capture, 'previewNew').mockImplementationOnce(async (...args) => {
        const compiled = await actual(...args);
        changePending();
        return compiled;
      });
    } else {
      const actual = f.service.capture.preview.bind(f.service.capture);
      vi.spyOn(f.service.capture, 'preview').mockImplementationOnce(async (...args) => {
        const compiled = await actual(...args);
        changePending();
        return compiled;
      });
    }
    await expect(
      f.service.approve(permId, { ...input, previewSha256: preview.preview.sha256 }, f.actor),
    ).rejects.toThrow(/changed|expired|review again/i);
    expectNoApprovalWrites(f);
  },
);

it.each(['cancel', 'expire'] as const)(
  'refuses a new approval when the live host request is %s during awaited compilation',
  async (change) => {
    const { f, permId, proof, input } = await selected('create');
    const preview = await f.service.preview(permId, input, f.actor);
    const actual = f.service.capture.previewNew.bind(f.service.capture);
    vi.spyOn(f.service.capture, 'previewNew').mockImplementationOnce(async (...args) => {
      const compiled = await actual(...args);
      if (change === 'cancel') removePending(permId);
      else
        registerPending(
          permId,
          proof.toolName,
          vi.fn(),
          proof.toolInput,
          undefined,
          proof.sessionId,
          {
            permId,
            sessionId: proof.sessionId,
            toolName: proof.toolName,
            toolInput: 'Expired host proposal',
            reviewKind: 'telos_source',
            expiresAt: Date.now() - 1,
          },
          { toolUseId: proof.toolUseId },
        );
      return compiled;
    });
    await expect(
      f.service.approve(permId, { ...input, previewSha256: preview.preview.sha256 }, f.actor),
    ).rejects.toThrow(/changed|expired/i);
    expectNoApprovalWrites(f);
  },
);

it.each(['create', 'adopt'] as const)(
  'refuses to return stale %s review candidates when the proposal changes while opening a message',
  async (kind) => {
    const { f, permId, proof } = await selected(kind);
    const actual = f.events.getSymposiumPerspectiveEvents.bind(f.events);
    vi.spyOn(f.events, 'getSymposiumPerspectiveEvents').mockImplementationOnce((...args) => {
      const events = actual(...args);
      registerPending(
        permId,
        proof.toolName,
        vi.fn(),
        { ...proof.toolInput, changed: true },
        undefined,
        proof.sessionId,
        {
          permId,
          sessionId: proof.sessionId,
          toolName: proof.toolName,
          toolInput: 'Changed proposal',
          reviewKind: 'telos_source',
          expiresAt: proof.expiresAt,
        },
        { toolUseId: proof.toolUseId },
      );
      return events;
    });
    await expect(f.service.review(permId, 'planning', f.actor)).rejects.toThrow(
      /changed|expired|review again/i,
    );
    expectNoApprovalWrites(f);
  },
);

it.each(['native', 'sdk'] as const)(
  'rejects a duplicate %s handler invocation without replacing the original pending resolver',
  async (marker) => {
    const f = createTelosSourceApprovalData();
    cleanup.push(() => f.close());
    const firstController = new AbortController(),
      duplicateController = new AbortController();
    const handler = buildPermissionHandler('offline-client', f.registry);
    const toolName = (marker === 'sdk' ? 'mcp__telos__' : '') + 'TelosCreateOutcome';
    const toolUseID = randomUUID();
    const proposal = {
      summary: 'One reviewed invocation',
      intent: 'Record clearly',
      rationale: 'Make music',
      acceptanceCriteria: ['Acoustic plan approved'],
      profile: 'personal',
      milestones: ['Install reviewed panels'],
    };
    let firstResult: { behavior: string } | undefined,
      duplicateResult: { behavior: string } | undefined;
    let permId: string | undefined;
    // Keep orphaned timers bounded even when reproducing the broken resolver
    // replacement; no simulated clock advance or provider execution is needed.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      void handler(toolName, proposal, { signal: firstController.signal, toolUseID }).then(
        (result) => {
          firstResult = result;
        },
      );
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      const firstEvents = f.drainEvents();
      permId = String(firstEvents.find((event) => event.type === 'permission_request')?.permId);
      const original = getPendingTelosSourceReview(permId, 'planning');
      expect(original).toBeDefined();
      void handler(toolName, proposal, { signal: duplicateController.signal, toolUseID }).then(
        (result) => {
          duplicateResult = result;
        },
      );
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      expect.soft(duplicateResult).toMatchObject({ behavior: 'deny' });
      expect
        .soft(f.drainEvents().filter((event) => event.type === 'permission_request'))
        .toEqual([]);
      duplicateController.abort();
      expect.soft(getPendingTelosSourceReview(permId, 'planning')).toEqual(original);
      expect.soft(firstResult).toBeUndefined();
      resolvePending(permId, 'deny', undefined, 'planning');
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
      expect.soft(firstResult).toMatchObject({ behavior: 'deny' });
      expectNoApprovalWrites(f);
    } finally {
      if (permId) resolvePending(permId, 'deny', undefined, 'planning');
      firstController.abort();
      duplicateController.abort();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  },
);
