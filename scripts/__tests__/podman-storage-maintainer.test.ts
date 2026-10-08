import { mkdtemp, rm, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  withStoreLock,
  writeState,
  readState,
  appendAudit,
  managedBuild,
  enrollStore,
} from '../lib/podman-storage-maintainer.mjs';
const roots: string[] = [];
const store = {
  machineId: 'guest',
  filesystemId: 'fs',
  graphRoot: '/store',
  graphDriver: 'overlay',
  rootless: true,
  connection: 'alias-a',
};
const id = `sha256:${'a'.repeat(64)}`;
async function root() {
  const path = await mkdtemp(join(tmpdir(), 'mitzo-storage-'));
  roots.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

describe('host store maintenance authority', () => {
  it('serializes aliases of the same store and never steals an existing lock', async () => {
    const home = await root();
    await withStoreLock(home, store, async () => {
      await expect(
        withStoreLock(home, { ...store, connection: 'alias-b' }, async () => {}),
      ).rejects.toThrow('locked');
    });
    await withStoreLock(home, store, async () => {});
  });
  it('makes lock waits cancellable without polling', async () => {
    const home = await root();
    await expect(
      withStoreLock(
        home,
        store,
        async () => {
          throw Error('should not enter');
        },
        AbortSignal.abort(),
      ),
    ).rejects.toThrow();
    await withStoreLock(home, store, async () => {});
  });
  it('persists state atomically and bounds the audit outside the store', async () => {
    const home = await root();
    await writeState(home, store, { builds: [], version: 1 });
    expect(await readState(home, store)).toEqual({ builds: [], version: 1 });
    for (let n = 0; n < 8; n++) await appendAudit(home, store, { n, detail: 'x'.repeat(100) }, 250);
    expect(await readFile(join(home, 'audit.jsonl'), 'utf8').catch(() => '')).toBe(''); // audit is store-scoped
    const [scope] = await readdir(home);
    const auditFiles = (await readdir(join(home, scope))).filter((n) => n.startsWith('audit'));
    expect(auditFiles.length).toBeLessThanOrEqual(3);
    for (const name of auditFiles)
      expect((await stat(join(home, scope, name))).size).toBeLessThanOrEqual(250);
  });
  it('does not silently adopt a legacy image or enroll an uncoordinated producer', async () => {
    const home = await root();
    await expect(
      enrollStore(home, store, {
        version: 1,
        review: 'review',
        store,
        producers: [{ owner: 'owner', family: 'family', coordinated: false, review: 'review' }],
        builds: [],
      }),
    ).rejects.toThrow();
    expect(await readState(home, store)).toBeNull();
  });
  it('records in-flight and exact completed build outputs under the shared lock', async () => {
    const home = await root();
    await enrollStore(home, store, {
      version: 1,
      review: 'review',
      store,
      producers: [{ owner: 'owner', family: 'family', coordinated: true, review: 'review' }],
      builds: [],
    });
    const recipe = {
      owner: 'owner',
      family: 'family',
      review: 'approved recipe',
      reproducible: true,
      inputsDigest: 'sha256:inputs',
    };
    await managedBuild(home, store, recipe, async () => {
      expect((await readState(home, store)).builds[0].state).toBe('active');
      await expect(withStoreLock(home, store, async () => {})).rejects.toThrow('locked');
      return [id];
    });
    const state = await readState(home, store);
    expect(state.builds[0]).toMatchObject({ state: 'succeeded', images: [id], reproducible: true });
    expect(state.builds[0].recipeDigest).toBeTruthy();
  });
  it('retains unknown build effects durably after failure and refuses another build', async () => {
    const home = await root();
    await enrollStore(home, store, {
      version: 1,
      review: 'review',
      store,
      producers: [{ owner: 'owner', family: 'family', coordinated: true, review: 'review' }],
      builds: [],
    });
    const recipe = {
      owner: 'owner',
      family: 'family',
      review: 'approved',
      reproducible: true,
      inputsDigest: 'sha256:inputs',
    };
    await expect(
      managedBuild(home, store, recipe, async () => {
        throw Error('timeout');
      }),
    ).rejects.toThrow('timeout');
    expect((await readState(home, store)).builds[0].state).toBe('uncertain');
    await expect(managedBuild(home, store, recipe, async () => [id])).rejects.toThrow('unresolved');
  });
  it('keeps a cancelled build uncertain even when its callback returns output IDs', async () => {
    const home = await root();
    await enrollStore(home, store, {
      version: 1,
      review: 'review',
      store,
      producers: [{ owner: 'owner', family: 'family', coordinated: true, review: 'review' }],
      builds: [],
    });
    const recipe = {
      owner: 'owner',
      family: 'family',
      review: 'approved',
      reproducible: true,
      inputsDigest: 'sha256:inputs',
    };
    const controller = new AbortController();
    await expect(
      managedBuild(
        home,
        store,
        recipe,
        async () => {
          controller.abort(Error('cancelled build'));
          return [id];
        },
        controller.signal,
      ),
    ).rejects.toThrow('cancelled build');
    expect((await readState(home, store)).builds[0].state).toBe('uncertain');
    const [scope] = await readdir(home);
    const audit = await readFile(join(home, scope, 'audit.jsonl'), 'utf8');
    expect(audit).toContain('build-uncertain');
    expect(audit).not.toContain('build-completed');
    await expect(managedBuild(home, store, recipe, async () => [id])).rejects.toThrow('unresolved');
  });
  it('pin updates cannot discard recorded build custody or an unresolved operation', async () => {
    const home = await root();
    const e = {
      version: 1,
      review: 'review',
      store,
      producers: [{ owner: 'owner', family: 'family', coordinated: true, review: 'review' }],
      builds: [],
    };
    await enrollStore(home, store, e);
    await managedBuild(
      home,
      store,
      {
        owner: 'owner',
        family: 'family',
        review: 'approved',
        reproducible: true,
        inputsDigest: 'sha256:inputs',
      },
      async () => [id],
    );
    await enrollStore(home, store, { ...e, review: 'pin revision' });
    expect((await readState(home, store)).builds[0].images).toEqual([id]);
  });
  it('refuses producer execution when the complete enrolled store identity changes', async () => {
    const home = await root();
    await enrollStore(home, store, {
      version: 1,
      review: 'review',
      store,
      producers: [{ owner: 'owner', family: 'family', coordinated: true, review: 'review' }],
      builds: [],
    });
    const changed = { ...store, machine: { created: 'replacement' } };
    let invoked = false;
    await expect(
      managedBuild(
        home,
        changed,
        {
          owner: 'owner',
          family: 'family',
          review: 'review',
          reproducible: true,
          inputsDigest: 'digest',
        },
        async () => {
          invoked = true;
          return [id];
        },
      ),
    ).rejects.toThrow('store');
    expect(invoked).toBe(false);
  });
});
