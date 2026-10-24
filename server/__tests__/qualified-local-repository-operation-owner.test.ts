import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventStore } from '../event-store.js';
import { setAuthRevocationStore } from '../auth.js';
import { captureLocalRepositoryPreparationAuthorization } from '../local-repository-preparation-authorization.js';
import { captureNativeHostReadOwner } from '../native-host-tool-context.js';
import * as readers from '../local-repository-native-read.js';
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
it.runIf(process.platform === 'darwin')(
  'awaits the actual consumed async decision owner before setup while its native base-read owner stays current',
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
        await held.approve();
        stage = 'approved';
        live = false;
        const native = captureNativeHostReadOwner(context)!;
        expect(native).toBeDefined();
        await expect(native.assertCurrent()).resolves.toBeUndefined();
        stage = 'native-current-after-source-revoke';
        const setup = vi
          .spyOn(readers, 'captureNativeLocalRepositoryReader')
          .mockRejectedValue(Error('Setup MUST NOT be reached'));
        await expect(held.materialize()).rejects.toMatchObject({
          code: 'pending_host_task_uncertain',
        });
        setupCalls = setup.mock.calls.length;
        stage = 'materialize-refused';
        expect(asyncDenials).toBeGreaterThan(0);
        expect(setup).not.toHaveBeenCalled();
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
  30000,
);
