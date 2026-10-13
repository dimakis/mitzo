import { expect, it } from 'vitest';
import { EventStore } from '../event-store.js';
import { ownedLocalCodexMetadata } from '../ordinary-local-codex-metadata.js';
import { createRoutesRuntimeLedgerFixture } from './fixtures/routes-runtime-ledger.js';

it('projects legacy route metadata through the complete empty runtime ledger fixture', () => {
  const store = createRoutesRuntimeLedgerFixture();
  expect(ownedLocalCodexMetadata(store, 'legacy')).toEqual({});
  expect(store.getSendCommand('missing')).toBeUndefined();
  expect(store.getOrdinaryLocalCommandAdmission('missing')).toBeUndefined();
});

it('keeps a retained local conversation visibly first-command-only after ending', () => {
  const store = new EventStore(':memory:');
  try {
    const binding = {
      version: 2,
      account: { accountId: 'personal', provider: 'openai-codex', profileRevision: 'r1' },
      harness: { implementation: 'codex' },
      execution: { location: 'local', targetId: 'host', targetRevision: 't1' },
    } as const;
    store.createSessionWithRuntimeBinding(
      {
        sessionId: 'retained',
        cwd: '/offline/checkout',
        repositoryWorkspaceId: 'workspace',
        accountBinding: { ...binding.account, accountLabel: 'Personal', model: 'fixture' },
      },
      binding,
    );
    store.setSessionState('retained', 'ENDED', { force: true });
    expect(ownedLocalCodexMetadata(store, 'retained')).toEqual({
      runtimeBinding: binding,
      runtimeCommandScope: 'first-command-only',
    });
    expect(JSON.stringify(ownedLocalCodexMetadata(store, 'retained'))).not.toContain('credential');
    store.upsertSession({ sessionId: 'legacy' });
    expect(ownedLocalCodexMetadata(store, 'legacy')).toEqual({});
    expect(ownedLocalCodexMetadata(store, 'missing')).toEqual({});
  } finally {
    store.close();
  }
});

it('advertises normal conversation scope only from a qualified retained runtime owner', () => {
  const store = {
    getSessionRuntimeBinding: () => ({
      version: 2,
      account: { accountId: 'personal', provider: 'openai-codex', profileRevision: 'account' },
      harness: { implementation: 'codex' },
      execution: { location: 'local', targetId: 'mac', targetRevision: 'target' },
    }),
  };
  expect(ownedLocalCodexMetadata(store as never, 'bound', true)).toMatchObject({
    runtimeCommandScope: 'conversation',
  });
  expect(ownedLocalCodexMetadata(store as never, 'bound', false)).toMatchObject({
    runtimeCommandScope: 'first-command-only',
  });
});
