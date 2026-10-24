import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { resolvePending } from '@mitzo/harness';
import { AccountBindingSchema, SessionRuntimeBindingV2Schema } from '@mitzo/protocol';
import { CodexTransportError } from '../codex-app-server-client.js';
import { EventStore } from '../event-store.js';
import { setAuthRevocationStore } from '../auth.js';
import { RepositoryWorkspaces } from '../repository-workspaces.js';
import { captureLocalRepositoryPreparationAuthorization } from '../local-repository-preparation-authorization.js';
import { captureLocalRepositoryAllocationFacts } from '../local-repository-allocation-facts.js';
import { localRepositoryPreparationSourceFacts } from '../local-repository-preparation-source.js';
import { localPreparationNativeFixture } from './fixtures/local-preparation-native.js';
import { fixtureReadAnchor } from './fixtures/local-repository-read-owner.js';
import type { NativeAnchoredReadRequest } from '../native-file-operation.js';

// Actual signed admission + authorization/permission handler + SQLite evidence.
// Source descriptor reads are explicit scratch-only substitutes, not SRT/helper.
// No object data, actor, task creation or native effects are invoked here.
vi.setConfig({ testTimeout: 30000 }); // Real signed owner/metadata/permission stages; no helper.
const cleanup: Array<() => void | Promise<void>> = [];
const revocations = new EventStore(':memory:');
setAuthRevocationStore(revocations);
afterAll(() => revocations.close());
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
async function descriptor(request: NativeAnchoredReadRequest, signal: AbortSignal) {
  signal.throwIfAborted();
  const stat = await lstat(request.file_path, { bigint: true });
  expect({ dev: String(stat.dev), ino: String(stat.ino) }).toEqual(request.identity);
  if (request.operation === 'ReadBytes') {
    const bytes = await readFile(request.file_path);
    if (bytes.length > request.limit && !request.prefix) throw Error('Fixture byte limit');
    const prefix = bytes.subarray(0, request.limit);
    return {
      content: request.prefix
        ? JSON.stringify({
            bytes: prefix.toString('base64'),
            truncated: prefix.length < bytes.length,
          })
        : prefix.toString('base64'),
      is_error: false,
    };
  }
  if (request.operation !== 'ListDirectory') throw Error('No unexpected fixture operation');
  let incomplete = false;
  const entries = [];
  for (const name of await readdir(request.file_path)) {
    const path = join(request.file_path, name);
    if (
      request.deniedRoots.some((root) => {
        const rest = relative(root, path);
        return !isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${sep}`);
      })
    ) {
      incomplete = true;
      continue;
    }
    const child = await lstat(path, { bigint: true });
    entries.push({
      name,
      identity: { dev: String(child.dev), ino: String(child.ino) },
      kind: child.isFile() ? 'file' : child.isDirectory() ? 'directory' : 'unsupported',
      size: Number(child.size),
      mode: Number(child.mode),
      nlink: Number(child.nlink),
      mtimeNs: String(child.mtimeNs),
      ctimeNs: String(child.ctimeNs),
    });
  }
  return {
    content: JSON.stringify({ identity: request.identity, entries, incomplete, truncated: false }),
    is_error: false,
  };
}
it.each([
  ['ask', 'allow'],
  ['agent', 'allow'],
  ['auto', 'allow'],
  ['ask', 'deny'],
  ['ask', 'cancel'],
  ['ask', 'revoked'],
  ['ask', 'malformed'],
] as const)(
  'requires a real exact one-use permission before any source/task effect in %s (action=%s)',
  async (mode, action) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw Error('No network/model calls');
      }),
    );
    let held!: Awaited<ReturnType<typeof captureLocalRepositoryPreparationAuthorization>>;
    let live = true;
    const sourceCurrent = vi.fn(() => {
      if (!live) throw Error('Original qualified source revoked');
    });
    const f = await localPreparationNativeFixture(
      cleanup,
      async (context, input) => {
        held = await captureLocalRepositoryPreparationAuthorization(
          {
            context,
            events: f.f.events,
            registry: f.registry,
            workspaces: service,
            qualifySource: async (path, original, intent) => {
              expect(original).toBe(context);
              const authority = {
                deadline: Date.now() + 30000,
                signal: context.signal,
                deniedRoots: context.nativeBaseReadScope!.deniedRoots,
                assertReadable: async (target: string) => {
                  context.assertCurrentSync();
                  if (
                    ![path, intent.taskRoot].some((root) => {
                      const rest = relative(root, target);
                      return !isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${sep}`);
                    })
                  )
                    throw Error('Outside fixture roots');
                },
                captureReadAnchor: fixtureReadAnchor,
                executeReadOperation: descriptor,
              };
              const captured = await captureLocalRepositoryAllocationFacts(authority, intent);
              return {
                ...localRepositoryPreparationSourceFacts(captured.facts),
                referenceCoverage: 'preparation-head-and-namespace-v1',
                allocationFacts: captured.facts,
                allocationFactsSha256: captured.factsSha256,
                publicationPackedRefs: captured.publicationPackedRefs,
                assertCurrentSync: () => {
                  context.assertCurrentSync();
                  return sourceCurrent();
                },
                assertCurrent: () => context.assertCurrent(),
                revalidateAllocationFacts: () => captured.verify(),
              };
            },
          },
          input,
        );
        const decision = await held.approve();
        return { state: decision.state };
      },
      { mode, nativeBaseReads: true },
    );
    const service = new RepositoryWorkspaces(join(f.f.root, 'repositories'), {
      assertLocalRepositoryAccess: async () => {
        throw Error('No ambient read authority');
      },
      authorize: async () => {
        throw Error('No remote authority');
      },
      ordinaryPreparation: {
        async capture(binding) {
          return {
            version: 1,
            originalBinding: AccountBindingSchema.parse(binding),
            runtimeBinding: SessionRuntimeBindingV2Schema.parse(
              f.f.events.getSessionRuntimeBinding(f.a.sessionId),
            ),
            credentialDigest: 'a'.repeat(64),
          };
        },
        async assert() {},
      },
    });
    cleanup.push(() => service.close());
    let card: Record<string, unknown> | undefined;
    f.setPermissionAction((event) => {
      card = event;
    });
    const source = join(f.f.root, 'source');
    const sourceFiles = ['.git/HEAD', '.git/index', 'task.txt'].map((path) => join(source, path));
    const witness = async () =>
      createHash('sha256')
        .update(Buffer.concat(await Promise.all(sourceFiles.map((path) => readFile(path)))))
        .digest('hex');
    const before = await witness();
    let settled = false;
    const pending = f.a.call({ path: source }).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(card).toBeDefined(), { timeout: 10000 });
    expect(settled).toBe(false);
    expect(f.permissions).toHaveLength(1);
    expect(f.a.session.sessionAllowList.size).toBe(0);
    expect(await witness()).toBe(before);
    for (const path of [
      held.scope.create.task.directory,
      ...Object.values(held.scope.sourceGitEffects),
    ])
      expect(existsSync(path)).toBe(false);
    const visible = card as Record<string, unknown>;
    expect(JSON.stringify(visible)).toContain(held.scope.create.task.directory);
    if (action === 'cancel') f.a.session.abortController.abort(Error('Original Stop'));
    if (action === 'revoked') live = false;
    if (action === 'malformed') sourceCurrent.mockImplementation(() => Promise.resolve(false));
    if (action !== 'cancel')
      resolvePending(
        visible.permId as string,
        action === 'deny' ? 'deny' : 'once',
        undefined,
        visible.sessionId as string,
      );
    const outcome = await pending.catch((error) => {
      if (error instanceof CodexTransportError && error.category === 'connection')
        return { response: { success: false }, value: undefined };
      throw error;
    });
    if (action === 'allow') expect(outcome.value).toEqual({ state: 'finalized' });
    else expect(outcome.response.success).toBe(false);
    expect(f.a.session.sessionAllowList.size).toBe(0);
    expect(await witness()).toBe(before);
    for (const path of [
      held.scope.create.task.directory,
      ...Object.values(held.scope.sourceGitEffects),
    ])
      expect(existsSync(path)).toBe(false);
    await expect(held.approve()).rejects.toThrow();
    expect(f.permissions).toHaveLength(1);
  },
);
