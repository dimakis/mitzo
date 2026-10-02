import { beforeEach, describe, expect, it, vi } from 'vitest';
const approve = vi.hoisted(() => vi.fn());
vi.mock('@mitzo/harness', async (original) => ({
  ...(await original<typeof import('@mitzo/harness')>()),
  buildPermissionHandler: () => approve,
}));
vi.mock('../public-web-fetch.js', () => ({ fetchPublicPage: vi.fn().mockResolvedValue('page') }));
import { createWebAccessTool } from '../web-access-tool.js';
import type { ManagedSession, SessionRegistry } from '@mitzo/harness';
describe('shared web access tool wiring', () => {
  beforeEach(() => approve.mockReset());
  function fixture(mode = 'agent') {
    const session = {
      clientId: 'owner',
      sessionId: 'conversation',
      mode,
      activeSkillPolicy: null,
      accountBinding: { accountId: 'a', provider: 'openai', model: 'm', profileRevision: '1' },
    } as unknown as ManagedSession;
    const registry = {
      findBySessionId: () => session,
      get: () => session,
    } as unknown as SessionRegistry;
    const search = vi.fn().mockResolvedValue('answer');
    return {
      session,
      registry,
      search,
      execute: createWebAccessTool('conversation', registry, search),
    };
  }
  it('forces a non-cacheable explicit approval in Auto mode too', async () => {
    const f = fixture('auto');
    const input = { operation: 'search', query: 'Revenue', reason: 'Check guidance' };
    approve.mockResolvedValue({ behavior: 'allow', updatedInput: input });
    expect(await f.execute(input, new AbortController().signal)).toMatchObject({ isError: false });
    expect(approve.mock.calls[0][2]).toMatchObject({
      forcePrompt: true,
      allowSessionGrant: false,
      approvalScope: 'session',
    });
  });
  it('does not expose search in Ask mode', async () => {
    const f = fixture('ask');
    expect(
      await f.execute(
        { operation: 'search', query: 'q', reason: 'why' },
        new AbortController().signal,
      ),
    ).toMatchObject({ isError: true });
    expect(approve).not.toHaveBeenCalled();
    expect(f.search).not.toHaveBeenCalled();
  });
  it('rejects an account changed while approval is pending', async () => {
    const f = fixture();
    const input = { operation: 'search', query: 'q', reason: 'why' };
    approve.mockImplementation(async () => {
      f.session.accountBinding!.accountId = 'other';
      return { behavior: 'allow', updatedInput: input };
    });
    expect(await f.execute(input, new AbortController().signal)).toMatchObject({ isError: true });
    expect(f.search).not.toHaveBeenCalled();
  });
});
