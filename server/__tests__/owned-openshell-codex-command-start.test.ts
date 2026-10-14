import { expect, it } from 'vitest';
import { OrdinaryOpenShellCodexCommandRequestSchema } from '../ordinary-openshell-codex-entry.js';
// Entry compilation cannot be supplied by a browser and binding metadata cannot
// choose a new account or native software at a continuation boundary.
it('refuses executable configuration and caller instructions on ordinary OpenShell entry', () => {
  const input = {
    runOn: 'openshell',
    repositoryWorkspaceId: 'cf414b54-96b4-42e7-bda4-74c55ad94ddf',
    clientMsgId: 'command',
    capabilityRevision: 'cap',
    runtime: {
      account: { accountId: 'personal', provider: 'openai-codex', profileRevision: 'profile' },
      harness: 'codex',
      targetId: 'shell',
      mode: 'agent',
    },
    selection: {
      version: 1,
      agent: { profileId: 'agent', revision: 1 },
      context: { source: 'none', revision: null },
      permission: { mode: 'agent', revision: 0 },
      model: 'offline',
      thinking: null,
    },
    payload: { text: 'offline' },
  };
  expect(OrdinaryOpenShellCodexCommandRequestSchema.parse(input)).toEqual(input);
  expect(
    OrdinaryOpenShellCodexCommandRequestSchema.safeParse({
      ...input,
      payload: { ...input.payload, systemPrompt: 'replace' },
    }).success,
  ).toBe(false);
  expect(
    OrdinaryOpenShellCodexCommandRequestSchema.safeParse({
      ...input,
      executablePath: '/private/codex',
    }).success,
  ).toBe(false);
});
