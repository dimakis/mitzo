import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

// Maintenance command only. Tests consume the pinned synthetic backup, never Git
// history/network or a production DB. No schema is handwritten or altered here.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const commit = '09f1090fd5be8b1167188a178dca2186eb445795';
const scratch = mkdtempSync(join(tmpdir(), 'symposium-old-owner-'));
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
try {
  execFileSync('tar', ['-x', '-C', scratch], {
    input: git('archive', commit, 'packages/protocol'),
  });
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'), 'dir');
  const entry = pathToFileURL(join(scratch, 'packages/protocol/src/event-store.ts')).href;
  const database = join(scratch, 'events.db');
  const receipt = join(scratch, 'receipt.json');
  const generator = join(scratch, 'generate.mjs');
  writeFileSync(
    generator,
    `
import { EventStore } from ${JSON.stringify(entry)};
import { writeFileSync } from 'node:fs';
const store = new EventStore(${JSON.stringify(database)});
try {
  const group = '00000000-0000-4000-8000-000000000191';
  store.upsertSession({sessionId:'migration-source',conversationSource:'mitzo'});
  store.collaborationConversation.begin(group,{requestId:'00000000-0000-4000-8000-000000000192',sessionId:'migration-source'});
  const review = store.collaborationConversation.saveSnapshot(group, {
    requestId:'00000000-0000-4000-8000-000000000193',sourceConversationId:'migration-source',
    boundary:{sequence:0,messageId:null},mode:'selected',purpose:'Synthetic historical review',
    joiningBrief:'Exact earlier brief',messages:[],artifacts:[],summary:null,
    capacity:{status:'unverified',reason:'Offline historical review; no native authority'}
  });
  writeFileSync(${JSON.stringify(receipt)},JSON.stringify({group,snapshotId:review.snapshotId,reviewSha256:review.sha256}));
} finally { store.close(); }
`,
  );
  execFileSync(
    process.execPath,
    ['--import', join(root, 'node_modules/tsx/dist/loader.mjs'), generator],
    {
      cwd: scratch,
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=1024' },
      stdio: 'pipe',
    },
  );
  const raw = readFileSync(database);
  const snapshot = gzipSync(raw);
  const target = join(root, 'server/__tests__/fixtures/symposium-event-store-09f1090f');
  writeFileSync(target + '.sqlite.gz', snapshot);
  writeFileSync(
    target + '.json',
    JSON.stringify(
      {
        generator: 'node scripts/generate-symposium-migration-fixture.mjs',
        ownerCommit: commit,
        ownerTree: git('rev-parse', commit + '^{tree}')
          .toString()
          .trim(),
        ownerSourceSha256: sha256(git('show', commit + ':packages/protocol/src/event-store.ts')),
        snapshotSha256: sha256(snapshot),
        sqliteSha256: sha256(raw),
        sqliteBytes: raw.length,
        syntheticOnly: true,
        schemaEdits: false,
        ...JSON.parse(readFileSync(receipt, 'utf8')),
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
