import { createHash } from 'node:crypto';
import {
  profileBuilderDefinition,
  PROFILE_BUILDER_REVISION,
  PROFILE_BUILDER_ID,
} from '@mitzo/protocol';
import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  invalidate: vi.fn(),
  revoked: (() => {}) as () => void,
}));
vi.mock('../auth.js', () => ({
  registerAuthSession: (_auth: unknown, onRevoked: () => void) => {
    mocks.revoked = onRevoked;
    return () => {};
  },
}));
vi.mock('../symposium-custodian-mode.js', () => ({
  custodianControllerClient: { request: mocks.request, invalidate: mocks.invalidate },
}));
import {
  bindAgentLibraryTransport,
  readBuiltinAgentLibraryProfile,
  readAgentLibraryProfile,
  captureAgentLibraryAuthorization,
  withAgentLibraryRecoveryAuthorization,
} from '../agent-library-transport.js';
const cleanups: (() => void)[] = [];
it('scopes a recovery to its verified login and releases the binding after admission', async () => {
  const auth = { id: 'verified-recovery', expiresAt: Date.now() + 10000 };
  let connectionId: string | undefined;
  await withAgentLibraryRecoveryAuthorization(auth, async (id) => {
    connectionId = id;
    expect(captureAgentLibraryAuthorization(id).auth).toBe(auth);
  });
  expect(() => captureAgentLibraryAuthorization(connectionId)).toThrow(/authentication/);
});
it('refuses expired recovery authorization before invoking startup and detects logout during it', async () => {
  const operation = vi.fn(async () => {});
  await expect(
    withAgentLibraryRecoveryAuthorization({ id: 'expired', expiresAt: Date.now() - 1 }, operation),
  ).rejects.toThrow(/authentication/);
  expect(operation).not.toHaveBeenCalled();
  await withAgentLibraryRecoveryAuthorization(
    { id: 'active', expiresAt: Date.now() + 10000 },
    async (id) => {
      const captured = captureAgentLibraryAuthorization(id);
      mocks.revoked();
      expect(() => captured.assertCurrent()).toThrow(/revoked/);
    },
  );
});
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  vi.clearAllMocks();
});
it('refuses an unbound or expired transport before reaching either catalog owner', async () => {
  await expect(
    readAgentLibraryProfile({ profileId: 'bob', revision: 3 }, 'unknown'),
  ).rejects.toThrow(/authentication/i);
  cleanups.push(bindAgentLibraryTransport('expired', { id: 'login', expiresAt: Date.now() - 1 }));
  await expect(
    readAgentLibraryProfile({ profileId: 'bob', revision: 3 }, 'expired'),
  ).rejects.toThrow(/authentication/i);
  expect(mocks.request).not.toHaveBeenCalled();
});
it('uses the middleware verified login for the exact retained-owner read', async () => {
  const auth = { id: 'verified-login', expiresAt: Date.now() + 10000 };
  cleanups.push(bindAgentLibraryTransport('connection', auth));
  mocks.request.mockResolvedValue({ status: 404, body: {} });
  expect(await readAgentLibraryProfile({ profileId: 'bob', revision: 3 }, 'connection')).toBeNull();
  expect(mocks.request).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: 'library.read',
      resourceId: 'bob',
      revision: '3',
      authorization: auth,
      body: {},
    }),
    undefined,
    expect.any(AbortSignal),
  );
});
it('invalidates an in-flight read on logout instead of returning its profile', async () => {
  cleanups.push(
    bindAgentLibraryTransport('connection', {
      id: 'verified-login',
      expiresAt: Date.now() + 10000,
    }),
  );
  mocks.request.mockImplementation(async () => {
    mocks.revoked();
    return { status: 404, body: {} };
  });
  await expect(
    readAgentLibraryProfile({ profileId: 'bob', revision: 3 }, 'connection'),
  ).rejects.toThrow(/revoked/i);
  expect(mocks.invalidate).toHaveBeenCalledWith('verified-login');
});

it('rechecks the same verified operator after context compilation and refuses revoked or replaced bindings', () => {
  const auth = { id: 'verified-login', expiresAt: Date.now() + 10000 };
  cleanups.push(bindAgentLibraryTransport('connection', auth));
  const captured = captureAgentLibraryAuthorization('connection');
  expect(captured.auth).toBe(auth);
  captured.assertCurrent();
  mocks.revoked();
  expect(() => captured.assertCurrent()).toThrow(/revoked/);
  cleanups.push(bindAgentLibraryTransport('connection', { ...auth, id: 'another-login' }));
  expect(() => captured.assertCurrent()).toThrow(/revoked/);
});

it('resolves the authenticated built-in builder as a pinned profile without catalog writes', async () => {
  cleanups.push(
    bindAgentLibraryTransport('builder', { id: 'login', expiresAt: Date.now() + 10000 }),
  );
  const builder = await readAgentLibraryProfile(
    { kind: 'builtin', profileId: 'mitzo-profile-builder', revision: PROFILE_BUILDER_REVISION },
    'builder',
  );
  expect(builder?.definition.name).toBe('Agent Builder');
  expect(builder?.contentHash).toBe(
    createHash('sha256').update(JSON.stringify(profileBuilderDefinition)).digest('hex'),
  );
  expect(mocks.request).not.toHaveBeenCalled();
  expect(
    await readAgentLibraryProfile(
      {
        kind: 'builtin',
        profileId: 'mitzo-profile-builder',
        revision: PROFILE_BUILDER_REVISION + 1,
      },
      'builder',
    ),
  ).toBeNull();
});

it('resolves the separate Tool Builder builtin with only bounded development capabilities', async () => {
  cleanups.push(
    bindAgentLibraryTransport('tool-builder', { id: 'login', expiresAt: Date.now() + 10000 }),
  );
  const selected = { kind: 'builtin' as const, profileId: 'mitzo-tool-builder', revision: 1 };
  const builder = await readAgentLibraryProfile(selected, 'tool-builder');
  expect(builder?.definition.name).toBe('Tool Builder');
  expect(builder?.definition.tools?.map((tool) => tool.id)).toEqual([
    'mitzo:ToolBuilderSearchCatalog',
    'mitzo:ToolBuilderReadContract',
    'mitzo:ToolBuilderPrepareDraft',
    'mitzo:ToolBuilderReviseDraft',
    'mitzo:ToolBuilderInspectDraft',
    'mitzo:ToolBuilderSubmitReview',
  ]);
  expect(builder?.definition.instructions).toContain('ToolBuilderSearchCatalog');
  expect(builder?.definition.instructions).toContain('src/index.mts');
  expect(mocks.request).not.toHaveBeenCalled();
  expect(await readAgentLibraryProfile({ ...selected, revision: 2 }, 'tool-builder')).toBeNull();
  builder!.definition.instructions = 'Mutated';
  expect(
    (await readAgentLibraryProfile(selected, 'tool-builder'))?.definition.instructions,
  ).not.toBe('Mutated');
});

it.each([1, 2])(
  'keeps catalog revision %s selectable when its ID matches the built-in',
  async (revision) => {
    cleanups.push(
      bindAgentLibraryTransport('collision', { id: 'login', expiresAt: Date.now() + 10000 }),
    );
    const definition = {
      ...profileBuilderDefinition,
      name: 'My saved builder',
      instructions: 'My own saved instructions.',
    };
    const saved = {
      profileId: 'mitzo-profile-builder',
      revision,
      definition,
      contentHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
    };
    mocks.request.mockResolvedValue({ status: 200, body: saved });
    expect(
      await readAgentLibraryProfile({ profileId: saved.profileId, revision }, 'collision'),
    ).toEqual(saved);
    expect(mocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'library.read',
        resourceId: saved.profileId,
        revision: String(revision),
      }),
      undefined,
      expect.any(AbortSignal),
    );
  },
);

it('retains the exact builtin revision one guidance for unsent historical Builder drafts', () => {
  const historical = readBuiltinAgentLibraryProfile({
    kind: 'builtin',
    profileId: PROFILE_BUILDER_ID,
    revision: 1,
  });
  expect(historical?.revision).toBe(1);
  expect(historical?.definition.instructions).not.toContain('AgentProposeTask');
  expect(historical?.definition.instructions).toContain('SymposiumProposeProfile');
  const current = readBuiltinAgentLibraryProfile({
    kind: 'builtin',
    profileId: PROFILE_BUILDER_ID,
    revision: PROFILE_BUILDER_REVISION,
  });
  expect(current?.definition.instructions).toContain('AgentProposeTask');
  expect(current?.contentHash).not.toBe(historical?.contentHash);
});
