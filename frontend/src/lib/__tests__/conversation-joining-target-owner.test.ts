// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prepareConversationJoiningTarget as prepare } from '../conversation-joining-target-owner';
import { getChatDraft, saveChatDraft } from '../chat-drafts';
import * as auth from '../api-fetch';
import { joiningTargetHarness as harness } from '../../test-utils/conversation-joining-target-harness';

const originalBase = import.meta.env.VITE_API_BASE_URL;
beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  auth.markAuthLost();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ok: true, authSessionId: 'target-owner-login' })),
  );
  await auth.restoreCookieAuthentication();
});
afterEach(() => {
  import.meta.env.VITE_API_BASE_URL = originalBase;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Recording HTTP only. No real GitHub, repository acquisition, filesystem,
 * native preparation, provider, account, capacity or session owner is invoked. */

it.each(['local', 'openshell'] as const)(
  'stages only a fresh ordinary %s target with all IDs/draft retained before effects',
  async (runOn) => {
    const h = harness(runOn);
    expect(h.transport).not.toHaveBeenCalled();
    const result = await prepare(h.options);
    const target = h.journal.readTarget()!;
    expect(result).toEqual({
      repositoryWorkspaceId: target.preview.requestId,
      permissionMode: 'agent',
    });
    expect(target.phase).toBe('resolved');
    expect(target.draft.id).not.toBe(target.preview.requestId);
    expect(target.preview.ordinaryRuntime.runOn).toBe(runOn);
    expect(target.draft.text).toBe('');
    expect(target.draft.contextBlocks).toEqual([]);
    expect(h.posts()).toHaveLength(2);
    expect(sessionStorage.length).toBe(1);
    expect(JSON.stringify(target)).not.toMatch(
      /nativeWitness|credentialDigest|capacity|providerResponseId/,
    );
  },
);

it.each(['preview-before', 'preview-after', 'prepare-before', 'prepare-after'] as const)(
  'recovers %s loss through original IDs without allocating a replacement',
  async (loss) => {
    const h = harness();
    h.lose(loss);
    await expect(prepare(h.options)).rejects.toThrow();
    const original = h.journal.readTarget()!;
    expect(await prepare({ ...h.options })).toEqual({
      repositoryWorkspaceId: original.preview.requestId,
      permissionMode: 'agent',
    });
    const retained = h.journal.readTarget()!;
    expect(retained.preview).toEqual(original.preview);
    expect(retained.draft.id).toBe(original.draft.id);
    const previews = h.posts().filter(([url]) => url.endsWith('/preview'));
    expect(previews).toHaveLength(loss === 'preview-before' ? 2 : 1);
    if (previews.length === 2) expect(previews[1][1]!.body).toBe(previews[0][1]!.body);
    expect(h.posts().filter(([url]) => url.endsWith('/prepare'))).toHaveLength(
      loss === 'prepare-before' ? 2 : 1,
    );
  },
);

it('does not reinterpret a missing known preview as absence or create another resource', async () => {
  const h = harness();
  h.lose('prepare-before');
  await expect(prepare(h.options)).rejects.toThrow();
  const original = h.journal.readTarget()!;
  h.resources.delete(original.preview.requestId);
  const count = h.posts().length;
  await expect(prepare(h.options)).rejects.toThrow();
  expect(h.posts()).toHaveLength(count);
  expect(h.journal.readTarget()).toEqual(original);
});

it('refuses changed review identity while original preparation is unknown', async () => {
  const h = harness();
  h.lose('prepare-before');
  await expect(prepare(h.options)).rejects.toThrow();
  const original = h.journal.read()!;
  expect(() =>
    h.journal.save(
      {
        ...original,
        reviewRequest: {
          ...original.reviewRequest,
          requestId: '00000000-0000-4000-8000-000000000099',
          setup: { ...original.reviewRequest.setup, runOn: 'openshell' },
        },
      },
      original,
    ),
  ).toThrow();
  expect(h.journal.read()).toEqual(original);
});

it('requires verified source repository intent and refuses a copied explicit source workspace/mode', async () => {
  const h = harness();
  await expect(prepare({ ...h.options, repository: null })).rejects.toThrow();
  const request = {
    ...h.request,
    requestId: '00000000-0000-4000-8000-000000000099',
    setup: {
      ...h.request.setup,
      repositoryWorkspaceId: 'claimed-source-workspace',
      permissionMode: 'auto' as const,
    },
  };
  const original = h.journal.read()!;
  h.journal.save({ ...original, reviewRequest: request }, original);
  await expect(prepare({ ...h.options, request })).rejects.toThrow();
  expect(h.transport).not.toHaveBeenCalled();
  expect(h.journal.readTarget()).toBeNull();
});

it('refuses a refreeze without its original retained target instead of preparing another workspace', async () => {
  const h = harness();
  const request = {
    ...h.request,
    previousSnapshot: {
      snapshotId: '00000000-0000-4000-8000-000000000099',
      sha256: 'a'.repeat(64),
    },
  };
  // A caller cannot obtain a new target from an unretained/refreeze request.
  await expect(prepare({ ...h.options, request })).rejects.toThrow();
  expect(h.transport).not.toHaveBeenCalled();
});

it.each(['route', 'repository'] as const)(
  'refuses ambiguous %s metadata without choosing its first candidate',
  async (kind) => {
    const h = harness();
    if (kind === 'route') h.inventory.routes.push(structuredClone(h.inventory.routes[0]));
    else h.ambiguousConnections();
    await expect(prepare(h.options)).rejects.toThrow();
    expect(h.posts()).toHaveLength(0);
    expect(h.journal.readTarget()).toBeNull();
  },
);

it('retires same-ID auth restoration before any preview or prepare mutation', async () => {
  const h = harness();
  h.after(async (path) => {
    if (path === '/api/chat/runtime/capabilities') {
      auth.markAuthLost();
      await auth.restoreCookieAuthentication();
    }
  });
  await expect(prepare(h.options)).rejects.toThrow();
  expect(h.posts()).toHaveLength(0);
  expect(h.journal.readTarget()).toBeNull();
});

it('retains completed-but-retired preparation for canonical status recovery without another POST', async () => {
  const h = harness();
  h.after((path) => {
    if (path.endsWith('/prepare')) h.retire();
  });
  await expect(prepare(h.options)).rejects.toThrow();
  const original = h.journal.readTarget()!;
  h.resume();
  h.after(undefined);
  const count = h.posts().length;
  expect(await prepare(h.options)).toEqual({
    repositoryWorkspaceId: original.preview.requestId,
    permissionMode: 'agent',
  });
  expect(h.posts()).toHaveLength(count);
});

it('fails before effects when session correlation storage is unavailable', async () => {
  const h = harness();
  const originalSet = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (this === sessionStorage) throw Error('Quota');
    return originalSet.call(this, key, value);
  });
  await expect(prepare(h.options)).rejects.toThrow();
  expect(h.posts()).toHaveLength(0);
});

it('restores the same empty ordinary draft after local quota failure without minting another preview ID', async () => {
  const h = harness();
  const originalSet = Storage.prototype.setItem;
  const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
    this: Storage,
    key,
    value,
  ) {
    if (this === localStorage) throw Error('Quota');
    return originalSet.call(this, key, value);
  });
  await expect(prepare(h.options)).rejects.toThrow();
  const original = h.journal.readTarget()!;
  expect(h.posts()).toHaveLength(0);
  spy.mockRestore();
  await prepare(h.options);
  expect(h.journal.readTarget()!.preview.requestId).toBe(original.preview.requestId);
  expect(getChatDraft(original.draft.id)).not.toBeNull();
});

it('never overwrites a subsequently edited ordinary draft or sends its content', async () => {
  const h = harness();
  h.lose('preview-before');
  await expect(prepare(h.options)).rejects.toThrow();
  const target = h.journal.readTarget()!;
  const draft = getChatDraft(target.draft.id)!;
  saveChatDraft({ ...draft, text: 'Human-owned draft text' });
  const count = h.posts().length;
  await expect(prepare(h.options)).rejects.toThrow();
  expect(h.posts()).toHaveLength(count);
  expect(getChatDraft(draft.id)!.text).toBe('Human-owned draft text');
});

it('preserves original correlation against stale writers, phase rewind and replacement while preparation is uncertain', async () => {
  const h = harness();
  h.lose('prepare-before');
  await expect(prepare(h.options)).rejects.toThrow();
  const original = h.journal.readTarget()!;
  const review = h.journal.read()!;
  expect(original.phase).toBe('prepare_pending');
  const replacement = structuredClone(original);
  replacement.preview.requestId = '00000000-0000-4000-8000-000000000099';
  replacement.draft.settings.repositoryWorkspaceId = replacement.preview.requestId;
  replacement.draft.id = '00000000-0000-4000-8000-000000000098';
  replacement.phase = 'preview_pending';
  expect(() => h.journal.retainTarget(replacement, original, review)).toThrow();
  expect(() =>
    h.journal.retainTarget({ ...original, phase: 'previewed' }, original, review),
  ).toThrow();
  expect(() => h.journal.retainTarget(original, null, review)).toThrow();
  expect(h.journal.readTarget()).toEqual(original);
  const count = h.posts().length;
  await prepare(h.options);
  expect(h.journal.readTarget()!.preview).toEqual(original.preview);
  expect(h.posts()).toHaveLength(count + 1);
});

it.each(['codex', 'responses'] as const)(
  'observes a genuine %s preview receipt without preparing a checkout or granting runtime readiness',
  async (harnessName) => {
    const h = harness();
    if (harnessName === 'responses')
      h.extra((path) =>
        path === '/api/chat/runtime/capabilities'
          ? Response.json({
              ...h.inventory,
              accounts: h.inventory.accounts.map((entry) => ({
                ...entry,
                account: { ...entry.account, provider: 'openai' },
              })),
              targets: h.inventory.targets.map((target) => ({ ...target, harness: harnessName })),
              routes: h.inventory.routes.map((route) => ({
                ...route,
                harness: harnessName,
                account: { ...route.account, provider: 'openai' },
              })),
            })
          : undefined,
      );
    const result = await prepare({ ...h.options, observeOnly: true });
    const original = h.journal.readTarget()!;
    expect(original.phase).toBe('resolved');
    expect(original.preview.ordinaryRuntime.runtime.harness).toBe(harnessName);
    expect(result).toEqual({
      repositoryWorkspaceId: original.preview.requestId,
      permissionMode: original.draft.settings.mode,
    });
    expect(h.resources.get(original.preview.requestId)).toMatchObject({ state: 'preview' });
    expect(h.resources.get(original.preview.requestId)?.ordinaryRuntime).toBeUndefined();
    expect(h.posts()).toHaveLength(1);
    expect(h.posts()[0][0]).toBe('/api/repository-workspaces/preview');
    const count = h.posts().length;
    expect(await prepare({ ...h.options, observeOnly: true })).toEqual(result);
    expect(h.posts()).toHaveLength(count);
    expect(h.journal.readTarget()).toEqual(original);
  },
);

it('captures observational intent before asynchronous callbacks can change the caller option', async () => {
  const h = harness();
  const options = { ...h.options, observeOnly: true };
  h.after(() => {
    options.observeOnly = false;
  });
  await prepare(options);
  expect(h.posts().filter(([url]) => url.endsWith('/prepare'))).toHaveLength(0);
});

it('keeps an unknown legacy preparation pinned and recovers its original ready receipt without another allocation', async () => {
  const h = harness();
  h.lose('prepare-before');
  await expect(prepare(h.options)).rejects.toThrow();
  const original = h.journal.readTarget()!;
  const count = h.posts().length;
  await expect(prepare({ ...h.options, observeOnly: true })).rejects.toThrow();
  expect(h.posts()).toHaveLength(count);
  expect(h.journal.readTarget()).toEqual(original);
  const resource = h.resources.get(original.preview.requestId)!;
  resource.state = 'ready';
  resource.ordinaryRuntime = structuredClone(h.runtime);
  expect(await prepare({ ...h.options, observeOnly: true })).toEqual({
    repositoryWorkspaceId: original.preview.requestId,
    permissionMode: original.draft.settings.mode,
  });
  expect(h.posts()).toHaveLength(count);
  expect(h.journal.readTarget()!.preview).toEqual(original.preview);
  expect(h.journal.readTarget()!.draft.id).toBe(original.draft.id);
});

it('replaces only an observed failed receipt without losing observational mode during recovery', async () => {
  const h = harness();
  await prepare({ ...h.options, observeOnly: true });
  const original = h.journal.readTarget()!;
  h.resources.get(original.preview.requestId)!.state = 'failed';
  const result = await prepare({ ...h.options, observeOnly: true });
  const replacement = h.journal.readTarget()!;
  expect(replacement.preview.requestId).not.toBe(original.preview.requestId);
  expect(result.repositoryWorkspaceId).toBe(replacement.preview.requestId);
  expect(h.resources.get(replacement.preview.requestId)?.state).toBe('preview');
  expect(h.posts().filter(([url]) => url.endsWith('/prepare'))).toHaveLength(0);
});
