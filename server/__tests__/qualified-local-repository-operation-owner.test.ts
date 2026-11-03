import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';
import { setAuthRevocationStore } from '../auth.js';
import { captureLocalRepositoryPreparationAuthorization } from '../local-repository-preparation-authorization.js';
import { captureNativeHostReadOwner } from '../native-host-tool-context.js';
import * as readers from '../local-repository-native-read.js';
import * as objectData from '../local-repository-preparation-object-data.js';
import * as objectProducer from '../local-repository-preparation-objects.js';
import * as sandbox from '../sandboxed-command.js';
import { localPreparationNativeFixture } from './fixtures/local-preparation-native.js';
import { fixtureQualifiedLocalPreparationSource } from './fixtures/qualified-local-preparation-source.js';

const cleanups: Array<() => void | Promise<void>> = [];
const revocations = new EventStore(':memory:');
setAuthRevocationStore(revocations);
afterAll(() => revocations.close());
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.runIf(process.platform === 'darwin' && process.env.MITZO_SANDBOX_INTEGRATION === '1')(
  'refuses source effects after private checkout when only the consumed source owner is revoked',
  async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw Error('No live/model/network calls');
      }),
    );
    let stage = 'initial',
      setupCalls = -1;
    let refused = false,
      live = true,
      asyncDenials = 0;
    const f = await localPreparationNativeFixture(
      cleanups,
      async (context, input) => {
        const source = input.path as string;
        const names = ['.git/HEAD', '.git/index', 'task.txt'];
        const before = names.map((name) => readFileSync(join(source, name)));
        // Explicit fixture source authority, not the production qualifier or a product
        // bypass. The ORIGINAL signed decision operation retains this exact callback.
        const held = await captureLocalRepositoryPreparationAuthorization(
          {
            context,
            registry: f.registry,
            events: f.f.events,
            workspaces: f.f.workspace,
            qualifySource: async (_path, _context, intent) =>
              fixtureQualifiedLocalPreparationSource(intent, {
                assertCurrentSync() {},
                async assertCurrent() {
                  if (!live) {
                    asyncDenials++;
                    throw Error('Original async source owner revoked');
                  }
                },
              }),
          },
          input,
        );
        const captureObjects = objectProducer.captureLocalRepositoryPreparationObjects;
        let artifactClosed = false;
        const dispose = vi.fn<() => Promise<void>>();
        vi.spyOn(objectProducer, 'captureLocalRepositoryPreparationObjects').mockImplementation(
          async (...args) => {
            const artifact = await captureObjects(...args);
            dispose.mockImplementation(async () => {
              await artifact.dispose();
              artifactClosed = true;
            });
            return Object.freeze({ ...artifact, dispose });
          },
        );
        // Use the genuine object producer before approval, as the real operation
        // does. Private artifact/staging custody is a distinct authority from
        // source/destination publication, so a header-only refusal cannot prove it.
        const objects = await objectData.captureLocalRepositoryPreparationObjectData(
          context,
          held.request,
          held.allocationFacts,
          held.allocationFactsSha256,
          Date.now() + 300000,
          held.publicationPackedRefs,
          held.objectSource,
        );
        cleanups.push(async () => {
          if (!artifactClosed) await objects.dispose();
        });
        await held.approve();
        stage = 'approved';
        const native = captureNativeHostReadOwner(context)!;
        expect(native).toBeDefined();
        await expect(native.assertCurrent()).resolves.toBeUndefined();
        stage = 'native-current-before-private-checkout';
        const originalCheckout = sandbox.executePrivateRepositoryStagingCheckout;
        const staging = vi
          .spyOn(sandbox, 'executePrivateRepositoryStagingCheckout')
          .mockImplementation(async (options) => {
            await originalCheckout(options);
            live = false; // Private computation completed; source effects must still refuse.
            await expect(native.assertCurrent()).resolves.toBeUndefined();
            stage = 'native-current-after-source-revoke';
          });
        const publication = vi.spyOn(sandbox, 'executePrivateNativeFileHelper');
        const setup = vi.spyOn(readers, 'captureNativeLocalRepositoryReader');
        await expect(held.materialize(objects)).rejects.toMatchObject({
          code: 'pending_host_task_uncertain',
        });
        expect(staging).toHaveBeenCalledOnce();
        // Enter the publication executor, whose original pre-worker full source
        // proof refuses. The actual native program must create no user paths.
        expect(publication).toHaveBeenCalledOnce();
        const record = f.f.workspace.get(held.request.id);
        expect(record.pendingHostTask?.state).toBe('materializing');
        expect(record.pendingHostTaskDecision?.state).toBe('consumed');
        expect(record.qualifiedLocalPreparation?.publication).toBeUndefined();
        expect(dispose).toHaveBeenCalledOnce();
        setupCalls = setup.mock.calls.length;
        stage = 'materialize-refused';
        expect(asyncDenials).toBe(2); // Before publication worker, then after joined refusal.
        expect(setup).not.toHaveBeenCalled(); // No published-task reader after source refusal.
        names.forEach((name, index) =>
          expect(readFileSync(join(source, name))).toEqual(before[index]),
        );
        for (const path of [
          held.scope.create.task.directory,
          held.scope.sourceGitEffects.administrationDirectory,
          held.scope.sourceGitEffects.branchReference,
          held.scope.sourceGitEffects.branchLog,
        ])
          expect(existsSync(path)).toBe(false);
        refused = true;
        return { refused: true };
      },
      { nativeBaseReads: true },
    );
    const result = await f.a.call({ path: join(f.f.root, 'source') });
    expect(
      result.response.success,
      JSON.stringify({ value: result.value, stage, setupCalls, asyncDenials }),
    ).toBe(true);
    expect(refused).toBe(true);
    expect(f.permissions).toHaveLength(1);
  },
  60000,
);
