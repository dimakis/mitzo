import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { createCollaborationRetainedArtifactFixture } from '../server/__tests__/fixtures/collaboration-retained-artifacts.js';
import { createTelosArtifactRouter } from '../server/telos-artifact-routes.js';
import { listenOnLoopback, closeTestServer } from '../server/__tests__/loopback-test-server.js';
const f = createCollaborationRetainedArtifactFixture();
const saved = f.store.save({
  itemId: f.itemId,
  filename: 'notes.md',
  title: 'Notes',
  bytes: Buffer.from('# Original'),
  sessionId: 'agent-original',
});
const app = express();
app.use(express.json());
app.use(
  createTelosArtifactRouter({
    dbPath: () => f.path,
    operatorAuth: (_req, res, next) => {
      res.locals.authSession = { id: 'synthetic-operator' };
      next();
    },
    verifyInternal: () => false,
    sessionId: () => undefined,
    readFile: async () => {
      throw Error('No workspace access');
    },
  }),
);
const server = await listenOnLoopback(app);
try {
  const url = `/api/telos/artifacts/${saved.id}/document`;
  const before = await request(server).get(url);
  const db = new Database(f.path);
  db.prepare('UPDATE items SET profile=? WHERE id=?').run('lifeops', f.itemId);
  db.close();
  const storeEditable = f.store.document(saved.id).editable;
  const preview = await request(server).get(url);
  const download = await request(server).get(saved.url);
  const edit = await request(server)
    .put(url)
    .send({ expectedRevision: 1, content: '# Edited', requestId: 'lifeops-diagnostic' });
  const current = f.store.read(saved.id);
  if (
    before.status !== 200 ||
    before.body.editable !== true ||
    storeEditable !== false ||
    preview.status !== 403 ||
    download.status !== 403 ||
    edit.status !== 403 ||
    current.revision !== 1 ||
    !current.bytes.equals(Buffer.from('# Original')) ||
    'content' in preview.body ||
    'path' in preview.body
  )
    throw Error('LifeOps denial contract violated');
  console.log(
    JSON.stringify(
      {
        fixture:
          'Canonical TodoStore-created backup plus supported artifact initialization, synthetic only',
        before: { status: before.status, editable: before.body.editable },
        afterProfile: 'lifeops',
        directStoreEditable: storeEditable,
        preview: { status: preview.status, body: preview.body },
        download: { status: download.status, body: download.body },
        edit: { status: edit.status, body: edit.body },
        retained: { revision: current.revision, sha256: current.sha256, exactOriginalBytes: true },
        interpretation:
          'Shared routes deny the whole private read; response is an error, not an editable:false document. Direct document-owner read-only semantics, save403 and immutable original bytes are preserved.',
      },
      null,
      2,
    ),
  );
} finally {
  server.closeAllConnections();
  await closeTestServer(server);
  f.close();
}
