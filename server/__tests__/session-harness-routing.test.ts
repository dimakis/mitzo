import { describe, expect, it } from 'vitest';
import { sessionHarnessForProvider } from '../session-harness-routing.js';
import {
  resolveNewOrdinarySessionRuntime,
  resolveOrdinarySessionRuntime,
  type OrdinarySessionRuntimeCatalog,
} from '../ordinary-session-runtime.js';

describe('shared new-work harness routing', () => {
  it.each([
    ['openai', 'codex'],
    ['openai-codex', 'codex'],
    ['anthropic-vertex', 'claude-sdk'],
    ['google-vertex', 'gemini'],
  ])('routes %s through %s independently of the execution target', (provider, harness) => {
    expect(sessionHarnessForProvider(provider)).toBe(harness);
  });

  it.each(['messages', 'chat-completions', 'unknown'])(
    'rejects unqualified %s providers',
    (provider) => {
      expect(() => sessionHarnessForProvider(provider)).toThrow(
        'Supported session harness unavailable',
      );
    },
  );

  const catalog: OrdinarySessionRuntimeCatalog = {
    deployment: 'ordinary',
    enabledHarnesses: ['responses', 'codex'],
    accounts: [
      {
        accountId: 'selected',
        provider: 'openai',
        profileRevision: 'r1',
        auth: { kind: 'api-credential', openshellTargetIds: ['sandbox'] },
      },
    ],
    targets: [
      { targetId: 'mac', targetRevision: 'm1', location: 'local' },
      {
        targetId: 'sandbox',
        targetRevision: 's1',
        location: 'openshell',
        ownership: 'dedicated-ordinary',
        openaiApi: 'enabled',
      },
    ],
  };
  const request = {
    account: { accountId: 'selected', provider: 'openai', profileRevision: 'r1' },
    harness: 'codex',
    targetId: 'mac',
    mode: 'agent',
  };

  it.each(['mac', 'sandbox'])(
    'keeps the exact API account for new Codex work on %s',
    (targetId) => {
      expect(resolveNewOrdinarySessionRuntime({ ...request, targetId }, catalog)).toMatchObject({
        status: 'compatible',
        binding: {
          account: request.account,
          harness: { implementation: 'codex' },
          execution: { targetId },
        },
      });
    },
  );

  it('rejects new legacy work while retaining the original compatibility contract for saved histories', () => {
    const legacy = { ...request, harness: 'responses' };
    expect(resolveOrdinarySessionRuntime(legacy, catalog).status).toBe('compatible');
    expect(resolveNewOrdinarySessionRuntime(legacy, catalog)).toEqual({
      status: 'rejected',
      code: 'new_work_harness_unsupported',
    });
  });

  it('does not substitute an enabled legacy engine or another account for unavailable Codex', () => {
    const disabled = { ...catalog, enabledHarnesses: ['responses'] };
    expect(resolveNewOrdinarySessionRuntime(request, disabled)).toEqual({
      status: 'rejected',
      code: 'harness_disabled',
    });
    expect(
      resolveNewOrdinarySessionRuntime({ ...request, harness: 'responses' }, disabled),
    ).toEqual({ status: 'rejected', code: 'new_work_harness_unsupported' });
    expect(
      resolveNewOrdinarySessionRuntime(
        { ...request, account: { ...request.account, accountId: 'missing' } },
        catalog,
      ),
    ).toEqual({ status: 'rejected', code: 'account_unavailable' });
  });
});
