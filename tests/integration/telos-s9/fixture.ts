import { vi } from 'vitest';
import Database from 'better-sqlite3';
import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { TelosWorkApiClient } from '../../../packages/client/src/telos-work-api.js';
import {
  createJoiningFixture,
  cleanupJoiningFixtures,
} from '../../../server/__tests__/fixtures/collaboration-joining.js';
import { createTelosWorkRouter } from '../../../server/telos-work-routes.js';
import { createTelosSourceRouter } from '../../../server/telos-source-routes.js';
import { createTelosWorkRoleHost } from '../../../server/telos-work-role-host.js';
import { isAvailableTelosWorkConversation } from '../../../server/telos-work-conversation.js';
import { TelosArtifactStore } from '../../../server/telos-artifact-store.js';

const cleanups: (() => void)[] = [];
export async function cleanupS9Fixtures() {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  await cleanupJoiningFixtures();
}

/** Own only the fixture composition. Actual SQLite, Git preparation, allocation,
 * context compiler, routers and client schemas run unchanged. Reuse the accepted
 * joining fixture's deterministic external repository/account effects. No app
 * bootstrap, environment/configuration loading, provider SDK or runtime starts. */
export async function createS9Fixture() {
  const ordinary = await createJoiningFixture();
  const root = mkdtempSync(join(tmpdir(), 'telos-s9-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = join(root, 'telos.db');
  const db = new Database(dbPath);
  const schema = readFileSync(new URL('./fixtures/canonical-schema.sql', import.meta.url), 'utf8');
  const provenance = JSON.parse(
    readFileSync(new URL('./fixtures/canonical-schema-source.json', import.meta.url), 'utf8'),
  );
  if (createHash('sha256').update(schema).digest('hex') !== provenance.schemaSha256)
    throw Error('Canonical schema bytes changed');
  db.exec(schema);
  for (const [id, parent, summary, intent, criteria] of [
    ['goal', null, 'Goal', 'Deliver the reviewed outcome', ['Independent review recorded']],
    ['outcome', 'goal', 'Repository-backed outcome', 'Keep the reviewed plan', ['Result reviewed']],
    ['child', 'outcome', 'Exact child', 'Implement only this child', ['Child reviewed']],
    ['sibling', 'outcome', 'Untouched sibling', 'Wait for explicit delegation', []],
  ] as const) {
    db.prepare(
      'INSERT INTO items(id,parent_id,summary,intent,acceptance_criteria,profile,first_seen,last_seen,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    ).run(
      id,
      parent,
      summary,
      intent,
      JSON.stringify(criteria),
      'manual',
      '2026-10-16T10:00:00Z',
      '2026-10-16T10:00:00Z',
      '2026-10-16T10:00:00Z',
      '2026-10-16T10:00:00Z',
    );
  }
  db.close();
  const available = (id: string) => isAvailableTelosWorkConversation(ordinary.store.getSession(id));
  const host = () =>
    createTelosWorkRoleHost({
      dbPath: () => dbPath,
      events: ordinary.store,
      ordinaryConversation: available,
      workspaces: () => ordinary.workspaces,
      resolvePreparation: ordinary.resolvePreparation,
      authorizeSettings: vi.fn(async () => {}),
    });
  const app = () => {
    const application = express();
    application.use(express.json());
    const operatorAuth: RequestHandler = (req, res, next) => {
      if (req.headers['x-s9-operator'] !== 'synthetic') {
        res.status(403).json({ code: 'unauthorized' });
        return;
      }
      res.locals.authSession = { id: 's9-offline-operator', expiresAt: Date.now() + 60_000 };
      next();
    };
    application.use(
      createTelosSourceRouter({
        dbPath: () => dbPath,
        events: ordinary.store,
        operatorAuth,
        ordinaryConversation: available,
      }),
    );
    application.use(
      createTelosWorkRouter({
        dbPath: () => dbPath,
        operatorAuth,
        ordinaryConversation: available,
        verifyInternal: () => false,
        sessionId: () => undefined,
        roleContext: (input) => host().context(input),
        roleSetup: (input) => host().setup(input),
      }),
    );
    return application;
  };
  let loseResponse = false;
  // Supertest crosses the actual Express middleware/router serialization boundary.
  // It does not call or proxy a live Mitzo backend. Only response-loss is injected.
  const api = new TelosWorkApiClient(async (url, init) => {
    const agent = request(app());
    const result = await (
      init?.method === 'POST' ? agent.post(url).send(JSON.parse(String(init.body))) : agent.get(url)
    ).set('x-s9-operator', 'synthetic');
    if (loseResponse && url.endsWith('/roles/setup') && result.status === 200) {
      loseResponse = false;
      throw Error('synthetic response loss after commit');
    }
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  const material = new TelosArtifactStore(dbPath);
  const saved = material.save({
    itemId: 'outcome',
    filename: 'plan.md',
    title: 'Reviewed plan',
    bytes: Buffer.from('Original retained plan'),
    sessionId: 'source',
  });
  material.close();
  const materialPin = { artifactId: saved.id, revision: saved.revision, sha256: saved.sha256 };
  const sequence = ordinary.store.append('source', 'user_message', {
    messageId: 'agreed-plan',
    text: 'Keep exactly this reviewed plan.',
  });
  const selection = {
    requestId: randomUUID(),
    expectedMembershipRevision: 0,
    sourceConversationId: 'source',
    mode: 'selected' as const,
    boundary: { sequence, messageId: 'agreed-plan' },
    messageIds: ['agreed-plan'],
    artifacts: [materialPin],
    purpose: 'Retain exact planning source',
    joiningBrief: '',
  };
  const withDb = <T>(action: (database: Database.Database) => T) => {
    const database = new Database(dbPath);
    try {
      return action(database);
    } finally {
      database.close();
    }
  };
  return {
    ordinary,
    dbPath,
    api,
    materialPin,
    get events() {
      return ordinary.store;
    },
    joiningInput(settings: typeof ordinary.input.settings) {
      // Capacity is selected-settings-specific. A new independent workspace
      // requires a new reviewed synthetic snapshot, never reuse the old proof.
      const snapshot = ordinary.store.collaborationConversation.saveSnapshot(ordinary.group, {
        requestId: randomUUID(),
        sourceConversationId: 'source',
        boundary: { sequence: 0, messageId: null },
        mode: 'selected',
        purpose: 'Review coexistence',
        joiningBrief: 'Inspect independently',
        messages: [],
        artifacts: [],
        summary: null,
        capacity: {
          status: 'ready',
          assessments: [
            {
              settings,
              availableTokens: 100,
              estimatedTokens: 10,
              estimatorRevision: 'synthetic-offline-only',
            },
          ],
        },
      });
      return {
        ...ordinary.input,
        settings,
        snapshot: { snapshotId: snapshot.snapshotId, sha256: snapshot.sha256 },
      };
    },
    async independentSettings() {
      const { binding } = await ordinary.resolvePreparation();
      const runtime = ordinary.input.settings.binding;
      const preview = await ordinary.workspaces.preview(
        binding,
        'connection',
        'example/repo',
        ordinary.signal,
        {
          runOn: 'local',
          runtime: {
            account: runtime.account,
            harness: 'codex',
            targetId: runtime.execution.targetId,
          },
        },
      );
      const prepared = await ordinary.workspaces.prepare(preview.id, binding, ordinary.signal);
      return { ...ordinary.input.settings, repositoryWorkspaceId: prepared.id };
    },
    async captureSource() {
      const preview = await api.previewSource({ itemId: 'outcome', selection });
      const receipt = await api.adoptSource({
        itemId: 'outcome',
        selection,
        requestId: 'adopt-source',
        expectedRevision: preview.packet.workRevision,
        previewSha256: preview.sha256,
      });
      return receipt.work.sources[0];
    },
    changeBrief() {
      withDb((database) =>
        database
          .prepare(
            "UPDATE items SET intent='Later reviewed brief',updated_at='2026-10-17T11:00:00Z' WHERE id='outcome'",
          )
          .run(),
      );
    },
    canonicalStatus(id: string) {
      return withDb(
        (database) =>
          (database.prepare('SELECT status FROM items WHERE id=?').get(id) as { status: string })
            .status,
      );
    },
    restart() {
      ordinary.reopen();
    },
    loseNextSetupResponse() {
      loseResponse = true;
    },
    replaceMaterial() {
      const artifacts = new TelosArtifactStore(dbPath);
      try {
        artifacts.save({
          itemId: 'outcome',
          filename: 'plan.md',
          title: 'Reviewed plan',
          bytes: Buffer.from('Later unadopted plan'),
          sessionId: 'source',
        });
      } finally {
        artifacts.close();
      }
    },
    readMaterial() {
      const artifacts = new TelosArtifactStore(dbPath);
      try {
        return artifacts.read(saved.id, saved.revision).bytes.toString();
      } finally {
        artifacts.close();
      }
    },
  };
}
