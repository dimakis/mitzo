import { afterEach, expect, it, vi } from 'vitest';
import { SessionRegistry } from '@mitzo/harness';
import { createCredentialSdkServer } from '../credential-sdk-tools.js';
import * as effects from '../session-credential-tools.js';
const sdk = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (input: Record<string, unknown>, extra?: unknown) => Promise<unknown>
  >(),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (
    name: string,
    _description: unknown,
    _schema: unknown,
    handler: (input: Record<string, unknown>, extra?: unknown) => Promise<unknown>,
  ) => {
    sdk.handlers.set(name, handler);
    return { name, handler };
  },
  createSdkMcpServer: () => ({ type: 'sdk', name: 'offline' }),
}));
afterEach(() => {
  vi.restoreAllMocks();
  sdk.handlers.clear();
});
it('passes final async and sync native authority into actual SDK profile handlers after an approval wait', async () => {
  let release: () => void = () => {},
    waiting: () => void = () => {},
    withdrawn = false;
  const entered = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const approved = new Promise<void>((resolve) => {
    release = resolve;
  });
  const effect = vi.fn();
  vi.spyOn(effects, 'sessionCredentialTools').mockImplementation(
    (_id, _session, _registry, _prefix, _integrations, assertAsync, assertSync) => ({
      definitions: [],
      execute: async () => {
        waiting();
        await approved;
        await assertAsync?.();
        assertSync?.();
        effect();
        return { content: 'offline', isError: false };
      },
    }),
  );
  const registry = new SessionRegistry();
  registry.register('owner', {
    sessionId: 'original',
    mode: 'agent',
    abortController: new AbortController(),
  } as never);
  const session = registry.get('owner')!;
  const assertCurrent = async () => {
    if (withdrawn) throw Error('Original selected authority withdrawn');
  };
  const assertCurrentSync = () => {
    if (withdrawn) throw Error('Original selected authority withdrawn');
  };
  createCredentialSdkServer(() => session.sessionId, session, registry, {
    profilesOnly: true,
    assertCurrent,
    assertCurrentSync,
  });
  expect([...sdk.handlers.keys()]).toEqual(['SymposiumProposeProfile', 'SymposiumReadProfiles']);
  const operation = sdk.handlers.get('SymposiumProposeProfile')!(
    {},
    { signal: new AbortController().signal },
  );
  await entered;
  withdrawn = true;
  release();
  await expect(operation).rejects.toThrow('Original selected authority withdrawn');
  expect(effect).not.toHaveBeenCalled();
});
