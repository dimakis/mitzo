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
it.each(['async', 'sync', 'wrapped'] as const)(
  'preserves %s native authority refusal after an SDK approval wait',
  async (phase) => {
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
          try {
            await assertAsync?.();
            assertSync?.();
          } catch (cause) {
            if (phase === 'wrapped') throw new Error('Guarded effect failed', { cause });
            throw cause;
          }
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
      if (withdrawn && phase !== 'sync') throw Error('Original selected authority withdrawn');
    };
    const assertCurrentSync = () => {
      if (withdrawn) throw Error('Original selected authority withdrawn');
    };
    createCredentialSdkServer(() => session.sessionId, session, registry, {
      profilesOnly: true,
      assertCurrent,
      assertCurrentSync,
    });
    expect([...sdk.handlers.keys()]).toEqual([
      'ListConnections',
      'SymposiumProposeProfile',
      'SymposiumReadProfiles',
      'TaskExecution',
      'SchedulePrompt',
      'SessionTimers',
      'SendSessionMessage',
      'CaptureMemoryCandidate',
    ]);
    const operation = sdk.handlers.get('SymposiumProposeProfile')!(
      {},
      { signal: new AbortController().signal },
    );
    await entered;
    withdrawn = true;
    release();
    await expect(operation).rejects.toThrow(
      phase === 'wrapped' ? 'Guarded effect failed' : 'Original selected authority withdrawn',
    );
    expect(effect).not.toHaveBeenCalled();
  },
);
