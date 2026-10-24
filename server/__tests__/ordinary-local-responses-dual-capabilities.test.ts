import { afterEach, expect, it, vi } from 'vitest';
import { AccountProfiles, loadAccountProfiles } from '../account-profiles.js';
import { ownedResponsesRuntimeFixture } from './fixtures/owned-local-responses-runtime.js';
import {
  localResponsesCapabilities,
  newLocalResponsesCapabilities,
  OrdinaryLocalResponsesTarget,
} from '../ordinary-local-responses-capabilities.js';
import { projectOrdinaryOpenShellCodexCapabilities } from '../ordinary-openshell-codex-route.js';
import { composeOrdinaryRuntimeCapabilities } from '../ordinary-runtime-capability-composition.js';
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it('projects retained Responses as history-only while new native entry remains separate', async () => {
  const f = await ownedResponsesRuntimeFixture(cleanups);
  const profiles = loadAccountProfiles();
  const target = new OrdinaryLocalResponsesTarget(f.dependencies.env);
  const fresh = newLocalResponsesCapabilities(profiles, target);
  const retained = localResponsesCapabilities(profiles, target);
  expect(fresh.inventory().routes).toEqual([]);
  expect(fresh.inventory().capabilityRevision).not.toBe(retained.inventory().capabilityRevision);
  expect(fresh.resolve(f.request.runtime)).toEqual({
    status: 'rejected',
    code: 'new_work_harness_unsupported',
  });
  expect(retained.inventory().routes).toEqual([]);
  expect(retained.inventory().accounts[0].account).toEqual(f.request.runtime.account);
  expect(retained.resolve(f.request.runtime)).toMatchObject({
    status: 'rejected',
    code: 'new_work_harness_unsupported',
  });
});
it('keeps deferred Gemini available without borrowing an OpenAI route', async () => {
  const f = await ownedResponsesRuntimeFixture(cleanups, { gemini: true });
  const catalog = newLocalResponsesCapabilities(
    loadAccountProfiles(),
    new OrdinaryLocalResponsesTarget(f.dependencies.env, 'gemini'),
  );
  expect(catalog.inventory().routes).toHaveLength(1);
  expect(catalog.resolve(f.request.runtime)).toMatchObject({
    status: 'compatible',
    binding: { account: f.request.runtime.account, harness: { implementation: 'gemini' } },
  });
});
it('offers an existing configured API account locally without managed re-enrollment', async () => {
  const f = await ownedResponsesRuntimeFixture(cleanups, { dual: true });
  const profiles = loadAccountProfiles();
  expect(profiles.isEnrolledOpenAIAccount('personal')).toBe(false);
  const local = localResponsesCapabilities(
    profiles,
    new OrdinaryLocalResponsesTarget(f.dependencies.env),
  ).inventory();
  expect(local.accounts).toHaveLength(1);
  expect(local.routes).toHaveLength(0);
  expect(local.accounts[0].account).toMatchObject({ accountId: 'personal', provider: 'openai' });
});
it('projects one enrolled API account through actual owning catalog resolvers for Local Responses and OpenShell Codex', async () => {
  vi.spyOn(AccountProfiles.prototype, 'isEnrolledOpenAIAccount').mockReturnValue(true);
  const f = await ownedResponsesRuntimeFixture(cleanups, { dual: true });
  const profiles = loadAccountProfiles();
  const local = localResponsesCapabilities(
    profiles,
    new OrdinaryLocalResponsesTarget(f.dependencies.env),
  );
  const shell = projectOrdinaryOpenShellCodexCapabilities({
    profiles,
    target: {
      targetId: 'shell',
      targetRevision: 'offline-target',
      location: 'openshell',
      ownership: 'dedicated-ordinary',
      openaiApi: 'enabled',
    },
    deployment: 'ordinary',
  });
  const merged = composeOrdinaryRuntimeCapabilities([local.inventory(), shell.inventory]);
  expect(merged.accounts).toHaveLength(1);
  expect(merged.routes.map((route) => route.harness)).toEqual(['codex']);
  const account = merged.accounts[0].account;
  expect(
    local.resolve({ account, harness: 'responses', targetId: f.target.targetId, mode: 'agent' }),
  ).toMatchObject({ status: 'rejected', code: 'new_work_harness_unsupported' });
  const shellResolution = (
    await import('../ordinary-session-runtime.js')
  ).resolveOrdinarySessionRuntime(
    { account, harness: 'codex', targetId: 'shell', mode: 'agent' },
    shell.catalog,
  );
  expect(shellResolution).toMatchObject({
    status: 'compatible',
    binding: { account, execution: { location: 'openshell' } },
  });
  const selected = profiles.resolve(account.accountId, 'next-model');
  expect(profiles.apiRoutingProfile(selected).credentialRef).toEqual(
    f.configuration[0].credentialRef,
  );
  expect(profiles.apiProfile(selected).credentialRef).toEqual(f.configuration[0].credentialRef);
  const unavailable = projectOrdinaryOpenShellCodexCapabilities({
    profiles,
    target: {
      ...shell.catalog.targets[0],
      location: 'openshell',
      ownership: 'dedicated-ordinary',
      openaiApi: 'disabled',
    } as never,
    deployment: 'ordinary',
  });
  expect(unavailable.inventory.routes).toHaveLength(0);
  expect(
    composeOrdinaryRuntimeCapabilities([local.inventory(), unavailable.inventory]).accounts[0]
      .account,
  ).toEqual(account);
});
