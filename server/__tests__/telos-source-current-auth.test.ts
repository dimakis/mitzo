import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import {
  authenticateToken,
  login,
  operatorAuthMiddleware,
  setAuthRevocationStore,
} from '../auth.js';
import { createTelosSourceRouter } from '../telos-source-routes.js';
import { TelosSourceCapture } from '../telos-source-capture.js';
import { createTelosSourceApprovalData } from './fixtures/telos-source-approval-data.js';

const cleanup: Array<() => void> = [];
const revokedIds = new Set<string>();
setAuthRevocationStore({
  isAuthSessionRevoked: (auth) => revokedIds.has(auth.id),
  revokeAuthSession: (auth) => {
    revokedIds.add(auth.id);
  },
});
afterEach(() => {
  vi.restoreAllMocks();
  revokedIds.clear();
  cleanup
    .splice(0)
    .reverse()
    .forEach((close) => close());
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function verifiedLogin() {
  const token = (await login(process.env.AUTH_PASSPHRASE!))!;
  const auth = (await authenticateToken(token))!;
  return { token, auth };
}
async function fixture() {
  const f = createTelosSourceApprovalData();
  cleanup.push(() => f.close());
  const identity = await verifiedLogin();
  const entered = deferred<void>(),
    release = deferred<void>();
  const createOutcome = vi.fn(async (body: Parameters<typeof f.createOutcome>[0]) => {
    const committed = await f.createOutcome(body);
    entered.resolve();
    await release.promise;
    return committed;
  });
  const app = express();
  app.use(express.json());
  app.use(
    createTelosSourceRouter({
      dbPath: () => f.dbPath,
      events: f.events,
      operatorAuth: operatorAuthMiddleware,
      ordinaryConversation: (id) => id === 'planning',
      createOutcome,
    }),
  );
  const post = (path: string, body: object, token = identity.token) =>
    request(app)
      .post('/api/telos/work/source/' + path)
      .set('Authorization', 'Bearer ' + token)
      .send(body);
  const get = (path: string, token = identity.token) =>
    request(app)
      .get('/api/telos/work/source/' + path)
      .set('Authorization', 'Bearer ' + token);
  const outcome = {
    summary: 'Current authorization',
    intent: 'Retain reviewed source',
    rationale: 'Keep custody',
    acceptanceCriteria: ['Exact packet'],
    milestones: ['Retain'],
    profile: 'personal',
  };
  const selection = {
    requestId: randomUUID(),
    expectedMembershipRevision: 0,
    sourceConversationId: 'planning',
    mode: 'selected',
    boundary: { sequence: 2, messageId: 'approved' },
    messageIds: ['approved'],
    artifacts: [],
    purpose: 'Save source',
    joiningBrief: '',
  };
  const counts = () => {
    const db = new Database(f.dbPath, { readonly: true });
    try {
      return Object.fromEntries(
        [
          'telos_artifact_revisions',
          'telos_work_sources',
          'telos_work_links',
          'sources',
          'links',
        ].map((table) => [
          table,
          (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
        ]),
      );
    } finally {
      db.close();
    }
  };
  return {
    ...f,
    post,
    get,
    outcome,
    selection,
    createOutcome,
    entered,
    release,
    identity,
    retainedCounts: counts,
    revoke: () => {
      revokedIds.add(identity.auth.id);
    },
    restore: () => {
      revokedIds.delete(identity.auth.id);
    },
  };
}

describe('current interactive authorization across source-save awaits', () => {
  for (const mode of ['direct', 'permission'] as const)
    it.each(['expired', 'revoked'] as const)(
      `${mode} preserves committed creation but refuses new source effects after %s authorization`,
      async (reason) => {
        const f = await fixture();
        let path: string, input: Record<string, unknown>, previewPacket: unknown;
        let permId: string | undefined;
        if (mode === 'direct') {
          path = 'outcome/create';
          input = { requestId: randomUUID(), outcome: f.outcome, selection: f.selection };
          const preview = await f.post('outcome/preview', input);
          expect(preview.status).toBe(200);
          previewPacket = preview.body.packet;
          input.previewSha256 = preview.body.sha256;
        } else {
          permId = String((await f.request({ kind: 'create', marker: 'native' })).permId);
          const review = await f.get(`permissions/${permId}?sessionId=planning`);
          expect(review.status).toBe(200);
          const message = review.body.messages.find(
            (m: { messageId: string }) => m.messageId === 'approved',
          );
          input = {
            sessionId: 'planning',
            requestId: randomUUID(),
            proposalSha256: review.body.proposalSha256,
            selection: {
              mode: 'selected',
              boundary: { sequence: message.sequence, messageId: message.messageId },
              messageIds: [message.messageId],
              artifacts: [],
            },
          };
          const preview = await f.post(`permissions/${permId}/preview`, input);
          expect(preview.status).toBe(200);
          previewPacket = preview.body.preview.packet;
          input.previewSha256 = preview.body.preview.sha256;
          path = `permissions/${permId}/approve`;
        }
        const before = f.retainedCounts();
        const pending = f.post(path, input).then((response) => response);
        await f.entered.promise;
        expect(f.counts().canonicalCreates).toBe(1);
        if (reason === 'expired')
          vi.spyOn(Date, 'now').mockReturnValue(f.identity.auth.expiresAt + 1);
        else f.revoke();
        f.release.resolve();
        const denied = await pending;
        expect.soft(denied.status).toBe(403);
        expect.soft(denied.body.code).toBe('unauthorized');
        expect.soft(f.retainedCounts()).toEqual(before);
        expect.soft(f.createOutcome).toHaveBeenCalledTimes(1);
        // Restore only the fixture's clock/revocation store for the SAME signed
        // jti. A new login below is never rebound to this prepared actor.
        vi.restoreAllMocks();
        f.restore();
        const other = await verifiedLogin();
        expect(other.auth.id).not.toBe(f.identity.auth.id);
        const mismatch = await f.post(path, input, other.token);
        expect(mismatch.status).toBe(mode === 'permission' ? 403 : 409);
        expect(f.createOutcome).toHaveBeenCalledTimes(1);
        expect(f.retainedCounts()).toEqual(before);
        const recovered = await f.post(path, input);
        expect(recovered.status).toBe(200);
        expect(f.createOutcome).toHaveBeenCalledTimes(1);
        if (mode === 'permission')
          expect(recovered.body.canonicalCreation).toMatchObject({
            created: true,
            delivery: { state: 'retained' },
          });
        const receipt = mode === 'permission' ? recovered.body.receipt : recovered.body;
        const snapshot = receipt.work.sources.at(-1);
        const pin = snapshot.artifacts.at(-1);
        expect(JSON.parse(f.artifacts.read(pin.artifactId, pin.revision).bytes.toString())).toEqual(
          previewPacket,
        );
        const completed = f.retainedCounts();
        f.revoke();
        expect((await f.post(path, input)).status).toBe(403);
        expect(f.retainedCounts()).toEqual(completed);
        f.restore();
        expect((await f.post(path, input)).body).toEqual(recovered.body);
        expect(f.retainedCounts()).toEqual(completed);
      },
    );
  it.each(['preview', 'adopt', 'approve'] as const)(
    'rechecks current authentication after awaited %s compilation before returning source or recording consent',
    async (operation) => {
      const f = await fixture();
      let path = 'outcome/preview';
      let input: Record<string, unknown> = {
        requestId: randomUUID(),
        outcome: f.outcome,
        selection: f.selection,
      };
      if (operation === 'adopt') {
        const preview = await f.post('preview', { itemId: 'studio', selection: f.selection });
        expect(preview.status).toBe(200);
        path = 'adopt';
        input = {
          itemId: 'studio',
          requestId: randomUUID(),
          selection: f.selection,
          expectedRevision: preview.body.packet.workRevision,
          previewSha256: preview.body.sha256,
        };
      } else if (operation === 'approve') {
        const permId = String((await f.request({ kind: 'create', marker: 'sdk' })).permId);
        const review = await f.get(`permissions/${permId}?sessionId=planning`);
        const message = review.body.messages.find(
          (m: { messageId: string }) => m.messageId === 'approved',
        );
        input = {
          sessionId: 'planning',
          requestId: randomUUID(),
          proposalSha256: review.body.proposalSha256,
          selection: {
            mode: 'selected',
            boundary: { sequence: message.sequence, messageId: message.messageId },
            messageIds: [message.messageId],
            artifacts: [],
          },
        };
        const preview = await f.post(`permissions/${permId}/preview`, input);
        expect(preview.status).toBe(200);
        input.previewSha256 = preview.body.preview.sha256;
        path = `permissions/${permId}/approve`;
      }
      const before = f.retainedCounts();
      f.release.resolve();
      const method = operation === 'adopt' ? 'preview' : 'previewNew';
      const actual: TelosSourceCapture['preview'] = TelosSourceCapture.prototype[method];
      vi.spyOn(TelosSourceCapture.prototype, method).mockImplementationOnce(async function (
        this: TelosSourceCapture,
        ...args: Parameters<TelosSourceCapture['preview']>
      ) {
        const result = await actual.apply(this, args);
        f.revoke();
        return result;
      });
      const response = await f.post(path, input);
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('unauthorized');
      expect(response.body.packet).toBeUndefined();
      expect(f.retainedCounts()).toEqual(before);
      expect(f.createOutcome).not.toHaveBeenCalled();
      const db = new Database(f.dbPath, { readonly: true });
      try {
        expect(db.prepare('SELECT COUNT(*) AS n FROM telos_work_source_approvals').get()).toEqual({
          n: 0,
        });
      } finally {
        db.close();
      }
    },
  );

  it('rechecks current authentication before returning asynchronously discovered public candidates', async () => {
    const f = await fixture();
    const permId = String((await f.request({ kind: 'create', marker: 'native' })).permId);
    const actual = f.events.getSymposiumPerspectiveEvents.bind(f.events);
    vi.spyOn(f.events, 'getSymposiumPerspectiveEvents').mockImplementationOnce((...args) => {
      const page = actual(...args);
      queueMicrotask(f.revoke);
      return page;
    });
    const response = await f.get(`permissions/${permId}?sessionId=planning`);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('unauthorized');
    expect(response.body.messages).toBeUndefined();
    expect(f.createOutcome).not.toHaveBeenCalled();
  });
});
