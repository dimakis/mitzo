import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  buildPermissionHandler,
  getPendingRequestsBySession,
  getPendingTelosSourceReview,
  SessionRegistry,
} from '@mitzo/harness';
import { eventStore as startupStore } from '../chat.js';
import { setAuthRevocationStore } from '../auth.js';
import { TelosSourceApproval } from '../telos-source-approval.js';
import { TelosSourceApprovalStore } from '../telos-source-approval-store.js';
import { createTelosWorkerMaterialsFixture } from './fixtures/telos-worker-materials.js';

const startup = await vi.hoisted(async () => {
  const fs = await import('node:fs'),
    os = await import('node:os'),
    path = await import('node:path');
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'native-source-material-startup-')),
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
  const x = await createTelosWorkerMaterialsFixture(cleanup),
    registry = new SessionRegistry();
  const controller = new AbortController();
  cleanup.push(() => controller.abort());
  registry.register('native-lead-source-client', {
    transport: { isOpen: () => true, send() {} },
    sessionId: x.leadId,
    abortController: controller,
    sessionAllowList: new Set(),
    mode: 'agent',
  });
  let current = true;
  const pending = buildPermissionHandler('native-lead-source-client', registry)(
    'TelosAdoptSource',
    { itemId: 'slice' },
    {
      signal: controller.signal,
      toolUseID: 'native:' + randomUUID(),
      forcePrompt: true,
      allowSessionGrant: false,
      nativeSourceScope: {
        operatorId: x.f.actor.id,
        assertCurrentSync() {
          if (!current) throw Error('Original native call retired');
        },
      },
    },
  );
  void pending.catch(() => {});
  await vi.waitFor(() => expect(getPendingRequestsBySession(x.leadId)).toHaveLength(1));
  const permId = getPendingRequestsBySession(x.leadId)[0].permId;
  const proof = getPendingTelosSourceReview(permId, x.leadId)!;
  const store = new TelosSourceApprovalStore(x.f.canonical.dbPath);
  cleanup.push(() => store.close());
  const service = new TelosSourceApproval({
    events: x.f.native.events,
    work: x.f.work,
    artifacts: x.f.canonical.artifacts,
    tasks: x.tasks,
    store,
    createOutcome: async () => {
      throw Error('No outcome creation in adoption');
    },
  });
  x.f.native.events.append(x.leadId, 'user_message', {
    messageId: 'lead-review-anchor',
    text:
      x.f.native.events.getSession(x.leadId)?.initialPrompt || 'Review this exact worker output.',
  });
  const review = await service.review(permId, x.leadId, x.f.actor);
  const m = review.messages.find((m) => m.messageId === 'lead-review-anchor')!;
  if (!m) throw Error('Real completed lead anchor unavailable');
  const input = {
    sessionId: x.leadId,
    requestId: randomUUID(),
    proposalSha256: review.proposalSha256,
    materialScopeSha256: review.materialScopeSha256,
    selection: {
      mode: 'selected' as const,
      boundary: { sequence: m.sequence, messageId: m.messageId },
      messageIds: [m.messageId],
      artifacts: [{ artifactId: x.output.id, revision: 1, sha256: x.output.sha256 }],
    },
  };
  const preview = await service.preview(permId, input, x.f.actor);
  const approved = { ...input, previewSha256: preview.preview.sha256 };
  return {
    ...x,
    registry,
    service,
    store,
    review,
    permId,
    proof,
    input,
    preview,
    approved,
    retire: () => {
      current = false;
    },
    count: () =>
      x.f.db
        .prepare('SELECT COUNT(*) AS n FROM telos_work_source_approvals WHERE receipt IS NOT NULL')
        .get(),
  };
}
it('offers unselected truthful worker provenance, compiles original lead messages and grants only completed same-lead/operator exact approval', async () => {
  const x = await fixture();
  expect(x.review.artifacts).toHaveLength(2);
  expect(x.review.artifacts.find((a) => a.artifactId === x.output.id)).toMatchObject({
    sessionId: x.workerId,
    workerOutput: { itemId: 'slice', title: 'slice' },
  });
  expect(x.preview.preview.packet.context.sourceConversationId).toBe(x.leadId);
  expect(x.preview.preview.packet.context.artifacts[0]).toMatchObject({
    sourceConversationId: x.workerId,
    sha256: x.output.sha256,
  });
  expect(x.store.approvedArtifactSelection(x.leadId, x.f.actor.id, x.output.id, 1)).toEqual([]);
  const receipt = await x.service.approve(x.permId, x.approved, x.f.actor);
  expect(receipt.receipt.work.itemId).toBe('slice');
  expect(x.store.approvedArtifactSelection(x.leadId, x.f.actor.id, x.output.id, 1)).toMatchObject([
    { pin: { sha256: x.output.sha256 } },
  ]);
  expect(x.store.approvedArtifactSelection(x.workerId, x.f.actor.id, x.output.id, 1)).toEqual([]);
  expect(x.store.approvedArtifactSelection(x.leadId, 'another-operator', x.output.id, 1)).toEqual(
    [],
  );
  x.tasks.update(x.taskId, { artifacts: {} });
  x.f.native.events.hideSession(x.workerId);
  x.retire();
  expect(await x.service.approve(x.permId, x.approved, x.f.actor)).toEqual(receipt);
  await expect(
    x.service.approve(
      x.permId,
      { ...x.approved, selection: { ...x.input.selection, artifacts: [] } },
      x.f.actor,
    ),
  ).rejects.toThrow();
});
it('rejects a crafted public sibling pin before reading its BLOB even without prior discovery', async () => {
  const x = await fixture();
  const other = x.f.canonical.artifacts.save({
    itemId: 'sibling',
    sessionId: x.workerId,
    filename: 'sibling.md',
    title: 'Sibling',
    bytes: Buffer.from('Sibling output'),
  });
  const read = vi.spyOn(x.f.canonical.artifacts, 'read');
  await expect(
    x.service.preview(
      x.permId,
      {
        ...x.input,
        selection: {
          ...x.input.selection,
          artifacts: [{ artifactId: other.id, revision: 1, sha256: other.sha256 }],
        },
      },
      x.f.actor,
    ),
  ).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
});
it('invalidates a material cursor and reviewed preview when the task output selection changes', async () => {
  const x = await fixture();
  x.tasks.update(x.taskId, { artifacts: {} });
  expect(() =>
    x.service.materials(
      x.permId,
      {
        sessionId: x.leadId,
        toolUseId: x.proof.toolUseId,
        proposalSha256: x.review.proposalSha256,
        after: x.review.artifactCursor!,
      },
      x.f.actor,
    ),
  ).toThrow();
  await expect(x.service.approve(x.permId, x.approved, x.f.actor)).rejects.toThrow();
  expect(x.count()).toEqual({ n: 0 });
});
it('checks the scope after compiler awaits and binds an own-material preview digest to the same worker scope', async () => {
  const x = await fixture();
  const ownInput = {
    ...x.input,
    selection: {
      ...x.input.selection,
      artifacts: [{ artifactId: x.own.id, revision: 1, sha256: x.own.sha256 }],
    },
  };
  const old = await x.service.preview(x.permId, ownInput, x.f.actor);
  const preview = x.service.capture.preview.bind(x.service.capture);
  vi.spyOn(x.service.capture, 'preview').mockImplementationOnce(async (...args) => {
    const result = await preview(...args);
    x.tasks.update(x.taskId, { artifacts: {} });
    return result;
  });
  await expect(x.service.preview(x.permId, ownInput, x.f.actor)).rejects.toThrow();
  const current = await x.service.review(x.permId, x.leadId, x.f.actor);
  const updated = { ...ownInput, materialScopeSha256: current.materialScopeSha256 };
  const next = await x.service.preview(x.permId, updated, x.f.actor);
  expect(next.preview.sha256).not.toBe(old.preview.sha256);
  await expect(
    x.service.approve(x.permId, { ...updated, previewSha256: old.preview.sha256 }, x.f.actor),
  ).rejects.toThrow();
  expect(x.count()).toEqual({ n: 0 });
});
it('rechecks prepared but uncompleted recovery before preview, approval and either fresh owner effect', async () => {
  const x = await fixture();
  vi.spyOn(x.service.capture, 'adopt').mockRejectedValueOnce(Error('Before source save'));
  await expect(x.service.approve(x.permId, x.approved, x.f.actor)).rejects.toThrow('uncertain');
  expect(x.store.lookup(x.permId, x.leadId, 'operator:' + x.f.actor.id)?.receipt).toBeNull();
  x.f.native.events.hideSession(x.workerId);
  await expect(x.service.review(x.permId, x.leadId, x.f.actor)).rejects.toThrow();
  await expect(x.service.preview(x.permId, x.input, x.f.actor)).rejects.toThrow();
  await expect(x.service.approve(x.permId, x.approved, x.f.actor)).rejects.toThrow();
  expect(x.count()).toEqual({ n: 0 });
});
it.each(['save', 'link'] as const)(
  'denies a changed task reference at the synchronous %s guard',
  async (point) => {
    const x = await fixture(),
      artifacts = x.f.canonical.artifacts;
    const save = artifacts.saveGuarded.bind(artifacts);
    vi.spyOn(artifacts, 'saveGuarded').mockImplementationOnce((input, guard) => {
      if (point === 'save') x.tasks.update(x.taskId, { artifacts: {} });
      const result = save(input, guard);
      if (point === 'link') x.tasks.update(x.taskId, { artifacts: {} });
      return result;
    });
    await expect(x.service.approve(x.permId, x.approved, x.f.actor)).rejects.toThrow();
    expect(x.f.work.read('slice', x.f.actor).sources).toEqual([]);
    expect(x.count()).toEqual({ n: 0 });
  },
);
