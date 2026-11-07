import { expect, it, vi } from 'vitest';
import { capabilityFixture } from './fixtures/session-capabilities.js';
import { sessionGoogleWorkspaceTools } from '../session-google-workspace-tools.js';
const { runtime, decide } = vi.hoisted(() => ({
  runtime: { googleWorkspace: { prepareRead: vi.fn() } },
  decide: vi.fn(),
}));
vi.mock('../connections-runtime.js', () => ({ getConnectionsRuntime: () => runtime }));
vi.mock('@mitzo/harness', async (original) => ({
  ...(await original<typeof import('@mitzo/harness')>()),
  buildPermissionHandler: () => decide,
}));

it('reuses Google file consent across read operations and fences delivery on revocation', async () => {
  const f = capabilityFixture();
  const grant = f.grants.create('operator', {
    sessionIds: ['one'],
    capability: {
      kind: 'google-read',
      email: 'me@example.test',
      resource: { kind: 'file', id: 'doc' },
    },
    durationMinutes: 60,
  });
  let revoke = false;
  const read = vi.fn(async (guard: () => Promise<void>) => {
    await guard();
    if (revoke) await f.grants.revoke('operator', 'one', grant.id);
    await guard();
    return 'private document';
  });
  runtime.googleWorkspace.prepareRead.mockResolvedValue({ email: 'me@example.test', read });
  decide.mockImplementation(async (_name, input) => ({
    behavior: 'deny',
    updatedInput: input,
    message: 'Denied',
  }));
  const tools = sessionGoogleWorkspaceTools({
    sessionId: 'one',
    session: f.session,
    registry: f.registry,
    assertCurrent: async () => {},
    assertCurrentSync() {},
  });
  for (const input of [
    { operation: 'drive.export', fileId: 'doc' },
    { operation: 'docs.get', documentId: 'doc' },
  ]) {
    const result = await tools.execute(input, new AbortController().signal);
    expect(result).toEqual({ content: 'private document', isError: false });
  }
  expect(decide).not.toHaveBeenCalled();
  expect(
    (
      await tools.execute(
        { operation: 'docs.get', documentId: 'different' },
        new AbortController().signal,
      )
    ).isError,
  ).toBe(true);
  expect(decide).toHaveBeenCalledOnce();
  revoke = true;
  const result = await tools.execute(
    { operation: 'docs.get', documentId: 'doc' },
    new AbortController().signal,
  );
  expect(result.isError).toBe(true);
  expect(result.content).not.toContain('private document');
});
