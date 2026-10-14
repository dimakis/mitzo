import { afterEach, expect, it, vi } from 'vitest';
import { AccountProfiles, loadAccountProfiles } from '../account-profiles.js';
import { ownedResponsesRuntimeFixture } from './fixtures/owned-local-responses-runtime.js';
import {
  localResponsesCapabilities,
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
  expect(merged.routes.map((route) => route.harness)).toEqual(['responses', 'codex']);
  const account = merged.accounts[0].account;
  expect(
    local.resolve({ account, harness: 'responses', targetId: f.target.targetId, mode: 'agent' }),
  ).toMatchObject({ status: 'compatible', binding: { account, execution: { location: 'local' } } });
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
