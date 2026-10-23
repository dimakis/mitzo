import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as actor from '../qualified-local-repository-actor.js';
import * as sandbox from '../sandboxed-command.js';
import { OwnedLocalCodexChatAdmission } from '../owned-local-codex-chat-admission.js';
import { EventStore } from '../event-store.js';
import { setAuthRevocationStore } from '../auth.js';
import { localPreparationNativeFixture } from './fixtures/local-preparation-native.js';
import { captureLocalRepositoryPreparationAuthorization } from '../local-repository-preparation-authorization.js';
import { captureNativeLocalRepositoryPreparationSource } from '../local-repository-preparation-source.js';

const cleanups: Array<() => void | Promise<void>> = [];
const revocations = new EventStore(':memory:');
setAuthRevocationStore(revocations);
afterAll(() => revocations.close());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const actual = it.runIf(
  process.platform === 'darwin' && process.env.MITZO_SANDBOX_INTEGRATION === '1',
);
actual(
  'materializes through the original signed permission and fixed actor while preserving dirty source and primary custody',
  async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw Error('No model or network calls');
      }),
    );
    let prepared = false;
    const phases: string[] = [];
    const mark = (name: string) => phases.push(`${name}:${Date.now()}`);
    const metrics = {
      admission: { calls: 0, ms: 0 },
      source: { calls: 0, ms: 0 },
      readTransports: { calls: 0, ms: 0 },
      effectTransports: { calls: 0, ms: 0 },
      checkouts: { calls: 0, ms: 0 },
      approvalRemainingMs: 0,
      consumptionRemainingMs: 0,
    };
    const nativeFull = OwnedLocalCodexChatAdmission.prototype.assertCurrent;
    vi.spyOn(OwnedLocalCodexChatAdmission.prototype, 'assertCurrent').mockImplementation(
      async function (this: OwnedLocalCodexChatAdmission) {
        const start = performance.now();
        metrics.admission.calls++;
        try {
          await Reflect.apply(nativeFull, this, []);
        } finally {
          metrics.admission.ms += performance.now() - start;
        }
      },
    );
    const readTransport = sandbox.executeSandboxedCommand,
      effectTransport = sandbox.executePrivateNativeFileHelper,
      checkout = sandbox.executePrivateRepositoryStagingCheckout;
    vi.spyOn(sandbox, 'executeSandboxedCommand').mockImplementation(async (...args) => {
      const start = performance.now();
      metrics.readTransports.calls++;
      try {
        return await readTransport(...args);
      } finally {
        metrics.readTransports.ms += performance.now() - start;
      }
    });
    vi.spyOn(sandbox, 'executePrivateNativeFileHelper').mockImplementation(async (...args) => {
      const start = performance.now();
      metrics.effectTransports.calls++;
      try {
        return await effectTransport(...args);
      } finally {
        metrics.effectTransports.ms += performance.now() - start;
      }
    });
    vi.spyOn(sandbox, 'executePrivateRepositoryStagingCheckout').mockImplementation(
      async (...args) => {
        const start = performance.now();
        metrics.checkouts.calls++;
        try {
          return await checkout(...args);
        } finally {
          metrics.checkouts.ms += performance.now() - start;
        }
      },
    );
    const actualActor = actor.materializeQualifiedLocalRepositoryTask;
    vi.spyOn(actor, 'materializeQualifiedLocalRepositoryTask').mockImplementation(
      async (...args) => {
        mark('actor-start');
        metrics.consumptionRemainingMs =
          (f.f.workspace.get(args[0].facts.workspaceId).pendingHostTaskDecision?.evidence
            .expiresAt ?? Date.now()) - Date.now();
        try {
          const result = await actualActor(...args);
          mark('actor-complete');
          return result;
        } catch (error) {
          mark('actor-error:' + String(error));
          throw error;
        }
      },
    );
    const f = await localPreparationNativeFixture(
      cleanups,
      async (context, input) => {
        mark('callback');
        const source = input.path as string;
        await writeFile(join(source, 'task.txt'), 'DIRTY SOURCE\n');
        await writeFile(join(source, 'untracked'), 'KEEP\n');
        const index = await readFile(join(source, '.git', 'index'));
        const head = await readFile(join(source, '.git', 'HEAD'));
        const authorization = await captureLocalRepositoryPreparationAuthorization(
          {
            context,
            registry: f.registry,
            events: f.f.events,
            workspaces: f.f.workspace,
            qualifySource: async (_path, original, intent) => {
              mark('qualify-start');
              const result = await captureNativeLocalRepositoryPreparationSource(original, intent);
              mark('qualify-end');
              return Object.freeze({
                ...result,
                async assertCurrent() {
                  const start = performance.now();
                  metrics.source.calls++;
                  try {
                    await result.assertCurrent();
                  } finally {
                    metrics.source.ms += performance.now() - start;
                  }
                },
              });
            },
          },
          input,
        );
        mark('authorization');
        await authorization.approve();
        mark('approved');
        metrics.approvalRemainingMs =
          (f.f.workspace.get(authorization.request.id).pendingHostTaskDecision?.evidence
            .expiresAt ?? Date.now()) - Date.now();
        const receipt = await authorization.materialize();
        expect(receipt.state).toBe('materialized');
        expect(receipt.taskIdentity?.linkedGit?.directory).toBe(
          authorization.scope.sourceGitEffects.administrationDirectory,
        );
        expect(await readFile(join(source, '.git', 'index'))).toEqual(index);
        expect(await readFile(join(source, '.git', 'HEAD'))).toEqual(head);
        expect(await readFile(join(source, 'task.txt'), 'utf8')).toBe('DIRTY SOURCE\n');
        expect(await readFile(join(source, 'untracked'), 'utf8')).toBe('KEEP\n');
        expect(f.f.workspace.getOrdinaryWorkspaceForConversation(context.conversationId)?.id).toBe(
          context.workspace.id,
        );
        expect(f.f.workspace.getForConversation(context.conversationId)).toBeUndefined();
        expect(await readFile(join(receipt.directory, '.git'), 'utf8')).toBe(
          `gitdir: ${authorization.scope.sourceGitEffects.administrationDirectory}\n`,
        );
        prepared = true;
        return { prepared: true };
      },
      { nativeBaseReads: true },
    );
    const result = await f.a.call({ path: join(f.f.root, 'source') });
    expect(
      result.response.success,
      JSON.stringify({ value: result.value, phases, metrics, permissions: f.permissions.length }),
    ).toBe(true);
    expect(result.value).toEqual({ prepared: true });
    expect(prepared).toBe(true);
    expect(f.permissions).toHaveLength(1);
  },
  300000,
);

it('refuses a fabricated operation in the actual signed callback before allocation or source effects', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw Error('No model or network calls');
    }),
  );
  const f = await localPreparationNativeFixture(cleanups, async (_context, input) => {
    const source = input.path as string;
    const head = await readFile(join(source, '.git', 'HEAD')),
      index = await readFile(join(source, '.git', 'index'));
    await expect(
      Promise.resolve().then(() =>
        f.f.workspace.materializeQualifiedPendingHostTask({ id: 'model-intent-only' } as never, {
          scope: {},
        }),
      ),
    ).rejects.toMatchObject({ code: 'pending_host_task_authority_required' });
    expect(await readFile(join(source, '.git', 'HEAD'))).toEqual(head);
    expect(await readFile(join(source, '.git', 'index'))).toEqual(index);
    return { refused: true };
  });
  const result = await f.a.call({ path: join(f.f.root, 'source') });
  expect(result.response.success, result.value).toBe(true);
  expect(result.value).toEqual({ refused: true });
  expect(f.permissions).toEqual([]);
}, 30000);
