import { afterAll, beforeAll, afterEach, expect, it, vi } from 'vitest';
import { eventStore as startupStore } from '../chat.js';
import { setAuthRevocationStore } from '../auth.js';
import { captureNativeTelosWorkerMaterials } from '../native-telos-worker-materials.js';
import { createTelosWorkerMaterialsFixture } from './fixtures/telos-worker-materials.js';

const startup = await vi.hoisted(async () => {
  const fs = await import('node:fs'),
    os = await import('node:os'),
    path = await import('node:path');
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'native-worker-material-startup-')),
  );
  vi.stubEnv('REPO_PATH', root);
  vi.stubEnv('MITZO_CODEX_PRIVATE_DIR', path.join(root, 'private'));
  vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_CONTROLLER', undefined);
  vi.stubEnv('MITZO_SYMPOSIUM_CUSTODIAN_OWNER', undefined);
  return { remove: () => fs.rmSync(root, { recursive: true, force: true }) };
});
vi.mock('../mcp-config.js', () => ({
  loadMcpServers: () => ({}),
  getMcpConfigPaths: () => [],
  loadFromFile: () => ({}),
}));
beforeAll(() => setAuthRevocationStore(startupStore));
afterAll(() => {
  startupStore.close();
  startup.remove();
  vi.unstubAllEnvs();
});

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const x = await createTelosWorkerMaterialsFixture(cleanup);
  let current = true;
  const options = {
    events: x.f.native.events,
    work: x.f.work,
    artifacts: x.f.canonical.artifacts,
    tasks: x.tasks,
    conversationId: x.leadId,
    itemId: 'slice',
    pendingIdentity: ['original-permission', 'original-tool-call'],
    assertCurrent() {
      if (!current) throw Error('Native pending retired');
    },
  };
  return {
    ...x,
    options,
    retire: () => {
      current = false;
    },
    capture: () => captureNativeTelosWorkerMaterials(options)!,
  };
}
it('resolves only original exact current worker output while preserving own lead material without BLOB reads', async () => {
  const x = await fixture();
  expect(x.f.work.read('slice', x.f.actor).assignments).toEqual([]);
  const read = vi.spyOn(x.f.canonical.artifacts, 'read');
  const scope = x.capture();
  expect(scope.workerPins).toEqual([
    { artifactId: x.output.id, revision: 1, sha256: x.output.sha256 },
  ]);
  scope.assertPin({ artifactId: x.output.id, revision: 1, sha256: x.output.sha256 });
  scope.assertPin({ artifactId: x.own.id, revision: 1, sha256: x.own.sha256 });
  expect(read).not.toHaveBeenCalled();
});
it('refuses crafted, cross-child, source-capture and operator-edited worker selectors', async () => {
  const x = await fixture();
  const save = (itemId: string, sessionId: string) =>
    x.f.canonical.artifacts.save({
      itemId,
      sessionId,
      filename: 'other.md',
      title: 'Other',
      bytes: Buffer.from('Other'),
    });
  const sibling = save('sibling', x.workerId),
    capture = save('slice', 'source-capture:worker');
  const edited = x.f.canonical.artifacts.editDocument({
    id: x.output.id,
    expectedRevision: 1,
    content: 'Operator edit',
    requestId: 'edit',
    operatorId: x.f.actor.id,
  });
  x.tasks.update(x.taskId, {
    artifacts: {
      a: `artifact:${sibling.id}@1`,
      b: `artifact:${capture.id}@1`,
      c: `artifact:${edited.id}@2`,
      d: `artifact:${x.output.id}`,
      e: 'file:/tmp/output.md',
    },
  });
  const scope = x.capture();
  expect(scope.workerPins).toEqual([]);
  for (const a of [x.output, sibling, capture, edited])
    expect(() =>
      scope.assertPin({ artifactId: a.id, revision: a.revision, sha256: a.sha256 }),
    ).toThrow();
});
it.each([
  'task-ref',
  'hidden-worker',
  'private-child',
  'archived-child',
  'retired-pending',
] as const)('denies the original captured scope after %s changes', async (change) => {
  const x = await fixture(),
    scope = x.capture();
  if (change === 'task-ref') x.tasks.update(x.taskId, { artifacts: {} });
  if (change === 'hidden-worker') x.f.native.events.hideSession(x.workerId);
  if (change === 'private-child')
    x.f.db.prepare("UPDATE items SET profile='LifeOps' WHERE id='slice'").run();
  if (change === 'archived-child')
    x.f.work.executeLifecycle(
      {
        operation: 'archive',
        itemId: 'slice',
        requestId: 'archive',
        expectedRevision: x.f.work.read('slice', x.f.actor).revision,
      },
      x.f.actor,
    );
  if (change === 'retired-pending') x.retire();
  expect(() => scope.assertCurrent()).toThrow();
  expect(() =>
    scope.assertPin({ artifactId: x.output.id, revision: 1, sha256: x.output.sha256 }),
  ).toThrow();
});

it.each([
  'retired-lead',
  'assigned-worker',
  'private-parent',
  'archived-parent',
  'trashed-parent',
  'hidden-lead',
  'execution-binding',
] as const)('denies fresh output after %s without changing historical evidence', async (change) => {
  const x = await fixture(),
    scope = x.capture();
  const originalOutput = x.f.canonical.artifacts.metadataForRevision(x.output.id, 1);
  if (change === 'retired-lead' || change === 'assigned-worker') {
    const itemId = change === 'retired-lead' ? 'studio' : 'slice';
    const role = change === 'retired-lead' ? 'lead' : 'worker';
    x.f.work.execute(
      {
        operation: 'setup_role',
        itemId,
        role,
        conversationId: x.f.native.first.receipt.sessionId,
        requestId: 'replace',
        expectedRevision: x.f.work.read(itemId, x.f.actor).revision,
        expectedAssignmentRevision:
          x.f.work.read(itemId, x.f.actor).assignments.find((a) => a.role === role)?.revision ?? 0,
      },
      x.f.actor,
    );
  }
  if (change === 'private-parent')
    x.f.db.prepare("UPDATE items SET profile='LifeOps' WHERE id='studio'").run();
  if (change === 'archived-parent' || change === 'trashed-parent')
    x.f.work.executeLifecycle(
      {
        operation: change === 'archived-parent' ? 'archive' : 'trash',
        itemId: 'studio',
        requestId: 'lifecycle',
        expectedRevision: x.f.work.read('studio', x.f.actor).revision,
      },
      x.f.actor,
    );
  if (change === 'hidden-lead') x.f.native.events.hideSession(x.leadId);
  if (change === 'execution-binding')
    vi.spyOn(x.tasks, 'getTelosExecutionBinding').mockReturnValue({
      ...x.tasks.getTelosExecutionBinding(x.taskId)!,
      childItemId: 'sibling',
    });
  expect(() => scope.assertCurrent()).toThrow();
  expect(x.f.canonical.artifacts.metadataForRevision(x.output.id, 1)).toEqual(originalOutput);
});
