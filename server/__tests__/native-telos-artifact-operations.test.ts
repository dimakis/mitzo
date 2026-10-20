import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { TelosSourceApprovalStore } from '../telos-source-approval-store.js';
import { createTelosSourceApprovalData } from './fixtures/telos-source-approval-data.js';
import { executeNativeTelosArtifactOperation } from '../native-telos-artifact-operations.js';
import type { NativeHostToolContext } from '../native-host-tool-context.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanup
    .splice(0)
    .reverse()
    .forEach((f) => f());
});
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function setup(name: 'TelosSaveArtifact' | 'TelosReadArtifact', raw: Record<string, unknown>) {
  const f = createTelosSourceApprovalData();
  cleanup.push(() => f.close());
  const approvals = new TelosSourceApprovalStore(f.dbPath);
  cleanup.push(() => approvals.close());
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'owned-artifact-tool-')));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'report.md'), 'Exact native output');
  const controller = new AbortController();
  cleanup.push(() => controller.abort());
  let current = true;
  const currentSync = vi.fn(() => {
    if (!current) throw Error('original scope retired');
  });
  // Component port fixture only. Real native/operator/account capture and once
  // permission are Core's independently tested producer/caller, not fabricated here.
  const role = {
    itemId: 'studio',
    artifacts: [
      { artifactId: f.material.id, revision: f.material.revision, sha256: f.material.sha256 },
    ],
    sources: [],
  };
  const context = Object.freeze({
    operatorId: f.actor.id,
    conversationId: 'planning',
    clientId: 'offline-client',
    turnId: 'actual-producer-port-fixture',
    callId: 'original-call',
    toolName: name,
    requestHash: hash(JSON.stringify(raw)),
    workspace: Object.freeze({ kind: 'ordinary', id: 'original-workspace', directory: root }),
    selectedRole: role,
    signal: controller.signal,
    assertCurrentSync: currentSync,
    async assertCurrent() {
      currentSync();
    },
    dispose() {
      controller.abort();
    },
  }) as unknown as NativeHostToolContext;
  const approve = vi.fn(async (_name: string, input: Record<string, unknown>) => ({
    behavior: 'allow' as const,
    updatedInput: structuredClone(input),
  }));
  const owners = {
    context,
    artifacts: f.artifacts,
    work: f.work,
    sources: f.service.capture,
    approvals,
    approve,
  };
  return {
    f,
    root,
    role,
    context,
    approve,
    owners,
    retire() {
      current = false;
    },
    run: () => executeNativeTelosArtifactOperation(owners, name, raw),
  };
}
const save = () => ({
  itemId: 'studio',
  filename: 'report.md',
  title: 'Native output',
  path: 'report.md',
  requestId: 'original-request',
});

it('returns an exact canonical retained output from the actual store and file owner', async () => {
  const input = save();
  const a = setup('TelosSaveArtifact', input);
  const result = await a.run();
  expect(result.isError).toBe(false);
  const body = JSON.parse(result.content);
  expect(body).toMatchObject({
    ok: true,
    artifact: {
      itemId: 'studio',
      filename: 'report.md',
      revision: 1,
      sha256: hash('Exact native output'),
      sessionId: 'planning',
      sourcePath: join(a.root, 'report.md'),
    },
  });
  expect(a.f.artifacts.read(body.artifact.id, 1).bytes.toString()).toBe('Exact native output');
  expect(a.approve).toHaveBeenCalledTimes(1);
});

it('recovers the same exact receipt before a changed/deleted file or another permission', async () => {
  const input = save();
  const a = setup('TelosSaveArtifact', input);
  const first = await a.run();
  rmSync(join(a.root, 'report.md'));
  a.approve.mockRejectedValue(Error('must not reopen approval'));
  expect(await a.run()).toEqual(first);
  expect(a.approve).toHaveBeenCalledTimes(1);
  const changed = { ...input, title: 'Changed request' };
  const context = { ...a.context, requestHash: hash(JSON.stringify(changed)) };
  expect(
    (
      await executeNativeTelosArtifactOperation(
        { ...a.owners, context },
        'TelosSaveArtifact',
        changed,
      )
    ).isError,
  ).toBe(true);
  expect(
    a.f.artifacts.list({ itemId: 'studio' }).find((x) => x.filename === 'report.md')?.revision,
  ).toBe(1);
});

it.each(['deny', 'input', 'retired', 'file'] as const)(
  'refuses %s changes across the real permission await without retaining output',
  async (kind) => {
    const a = setup('TelosSaveArtifact', save());
    if (kind === 'deny')
      a.approve.mockResolvedValue({ behavior: 'deny', message: 'denied' } as never);
    if (kind === 'input')
      a.approve.mockResolvedValue({
        behavior: 'allow',
        updatedInput: { ...save(), filename: 'other.md' },
      });
    if (kind === 'retired')
      a.approve.mockImplementation(async () => {
        a.retire();
        return { behavior: 'allow', updatedInput: save() };
      });
    if (kind === 'file')
      a.approve.mockImplementation(async () => {
        writeFileSync(join(a.root, 'report.md'), 'Different bytes');
        return { behavior: 'allow', updatedInput: save() };
      });
    expect((await a.run()).isError).toBe(true);
    expect(a.f.artifacts.list({ itemId: 'studio' }).some((x) => x.filename === 'report.md')).toBe(
      false,
    );
  },
);

it.each(['../outside.md', '.env'] as const)(
  'refuses private/outside %s using the existing file policy',
  async (path) => {
    const a = setup('TelosSaveArtifact', { ...save(), path });
    expect((await a.run()).isError).toBe(true);
    expect(a.approve).not.toHaveBeenCalled();
  },
);

it('preserves inline exact UTF-8 bytes and rejects unknown public authority fields', async () => {
  const raw = {
    itemId: 'studio',
    filename: 'inline.md',
    title: 'Inline',
    content: '  Exact\r\nπ  ',
    requestId: 'inline-request',
  };
  const a = setup('TelosSaveArtifact', raw);
  const body = JSON.parse((await a.run()).content);
  expect(a.f.artifacts.read(body.artifact.id, 1).bytes.toString()).toBe(raw.content);
  const wrong = { ...raw, authorized: true };
  const context = { ...a.context, requestHash: hash(JSON.stringify(wrong)) };
  expect(
    (
      await executeNativeTelosArtifactOperation(
        { ...a.owners, context },
        'TelosSaveArtifact',
        wrong,
      )
    ).isError,
  ).toBe(true);
});

it('reads only the exact selected older revision, never current/latest bytes', async () => {
  const a = setup('TelosReadArtifact', { id: 'placeholder', revision: 1 });
  a.f.artifacts.save({
    itemId: 'studio',
    filename: a.f.material.filename,
    title: 'Latest',
    bytes: Buffer.from('UNSELECTED NEWER'),
    sessionId: 'another-editor',
  });
  const raw = { id: a.f.material.id, revision: 1 };
  const context = { ...a.context, requestHash: hash(JSON.stringify(raw)) };
  const result = await executeNativeTelosArtifactOperation(
    { ...a.owners, context },
    'TelosReadArtifact',
    raw,
  );
  expect(result.isError).toBe(false);
  const body = JSON.parse(result.content);
  expect(body).toMatchObject({
    artifact: { revision: 1, sha256: a.f.material.sha256, content: 'The reviewed panel layout.' },
  });
  expect(result.content).not.toContain('UNSELECTED NEWER');
});

it.each(['latest', 'unselected', 'wrong-hash', 'privacy', 'bytes'] as const)(
  'refuses %s material selection/currentness without returned content',
  async (fault) => {
    const a = setup('TelosReadArtifact', {});
    const raw: Record<string, unknown> = { id: a.f.material.id, revision: 1 };
    if (fault === 'latest') delete raw.revision;
    if (fault === 'unselected') raw.revision = 2;
    if (fault === 'wrong-hash') a.role.artifacts[0].sha256 = '0'.repeat(64);
    if (fault === 'privacy' || fault === 'bytes')
      a.approve.mockImplementation(async (_name, input) => {
        const db = new Database(a.f.dbPath);
        try {
          if (fault === 'privacy')
            db.prepare('UPDATE items SET profile=? WHERE id=?').run('lifeops', 'studio');
          else
            db.prepare('UPDATE telos_artifact_revisions SET bytes=? WHERE id=?').run(
              Buffer.alloc(a.f.material.size, 33),
              a.f.material.id,
            );
        } finally {
          db.close();
        }
        return { behavior: 'allow', updatedInput: input };
      });
    const context = { ...a.context, requestHash: hash(JSON.stringify(raw)) };
    const result = await executeNativeTelosArtifactOperation(
      { ...a.owners, context },
      'TelosReadArtifact',
      raw,
    );
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain('The reviewed panel layout.');
  },
);

it('does not admit arbitrary Find or a different original native tool/input identity', async () => {
  const a = setup('TelosSaveArtifact', save());
  expect(
    (await executeNativeTelosArtifactOperation(a.owners, 'TelosFindArtifacts' as never, save()))
      .isError,
  ).toBe(true);
  expect(
    (
      await executeNativeTelosArtifactOperation(
        { ...a.owners, context: { ...a.context, toolName: 'other' } },
        'TelosSaveArtifact',
        save(),
      )
    ).isError,
  ).toBe(true);
  expect(a.approve).not.toHaveBeenCalled();
});

it.each(['create', 'adopt'] as const)(
  'reads exact completed %s source pins before role setup using the real current operator and source owners',
  async (kind) => {
    const a = setup('TelosReadArtifact', {});
    const permission = await a.f.request({ kind, marker: 'native' });
    const permId = String(permission.permId);
    const review = await a.f.service.review(permId, 'planning', a.f.actor);
    const message = review.messages.find((m) => m.messageId === 'approved')!;
    const pin = { artifactId: a.f.material.id, revision: 1, sha256: a.f.material.sha256 };
    const input = {
      sessionId: 'planning',
      requestId: randomUUID(),
      proposalSha256: review.proposalSha256,
      selection: {
        mode: 'selected' as const,
        boundary: { sequence: message.sequence, messageId: message.messageId },
        messageIds: [message.messageId],
        artifacts: [pin],
      },
    };
    const preview = await a.f.service.preview(permId, input, a.f.actor);
    const receipt = await a.f.service.approve(
      permId,
      { ...input, previewSha256: preview.preview.sha256 },
      a.f.actor,
    );
    await a.f.settled();
    a.f.advanceMaterial();
    const source = receipt.receipt.work.sources.find(
      (s) => s.snapshotId === receipt.sourceSnapshotId,
    )!;
    const packet = source.artifacts.at(-1)!;
    const read = vi.spyOn(a.f.service.capture, 'read');
    for (const selected of [pin, packet]) {
      const raw = { id: selected.artifactId, revision: selected.revision };
      const context = {
        ...a.context,
        selectedRole: undefined,
        requestHash: hash(JSON.stringify(raw)),
      };
      const result = await executeNativeTelosArtifactOperation(
        { ...a.owners, context },
        'TelosReadArtifact',
        raw,
      );
      expect(result.isError).toBe(false);
      const body = JSON.parse(result.content);
      expect(body.artifact.sha256).toBe(selected.sha256);
      expect(hash(body.artifact.content)).toBe(selected.sha256);
      for (const wrong of [
        { operatorId: 'another-signed-operator' },
        { conversationId: 'another-conversation' },
      ])
        expect(
          (
            await executeNativeTelosArtifactOperation(
              { ...a.owners, context: { ...context, ...wrong } },
              'TelosReadArtifact',
              raw,
            )
          ).isError,
        ).toBe(true);
      if (selected === packet) {
        expect(read).toHaveBeenCalledWith(source.itemId, source.snapshotId, a.f.actor);
        expect(
          (
            await executeNativeTelosArtifactOperation(
              { ...a.owners, sources: undefined, context },
              'TelosReadArtifact',
              raw,
            )
          ).isError,
        ).toBe(true);
        a.f.hideOriginalSource();
        // The actual source owner retains immutable bytes when the original chat
        // becomes unavailable; its backlink availability is not a new read grant.
        expect(
          (
            await executeNativeTelosArtifactOperation(
              { ...a.owners, context },
              'TelosReadArtifact',
              raw,
            )
          ).isError,
        ).toBe(false);
      }
    }
    const raw = { id: pin.artifactId, revision: 2 };
    expect(
      (
        await executeNativeTelosArtifactOperation(
          {
            ...a.owners,
            context: {
              ...a.context,
              selectedRole: undefined,
              requestHash: hash(JSON.stringify(raw)),
            },
          },
          'TelosReadArtifact',
          raw,
        )
      ).isError,
    ).toBe(true);
    expect(a.f.retainedOwnerCounts()).toMatchObject({ sources: 1, allocations: 0 });
  },
);

it.each(['async', 'nonvoid'] as const)(
  'refuses a %s synchronous native fence before any permission or effect',
  async (kind) => {
    const a = setup('TelosSaveArtifact', save());
    const context = {
      ...a.context,
      assertCurrentSync: () => (kind === 'async' ? Promise.reject(Error('not synchronous')) : true),
    } as unknown as NativeHostToolContext;
    expect(
      (
        await executeNativeTelosArtifactOperation(
          { ...a.owners, context },
          'TelosSaveArtifact',
          save(),
        )
      ).isError,
    ).toBe(true);
    expect(a.approve).not.toHaveBeenCalled();
  },
);
