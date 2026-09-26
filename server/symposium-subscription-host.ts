import { spawnSync } from 'node:child_process';
import { AccountProfiles } from './account-profiles.js';
import { CatalogModel } from './model-catalog.js';
import { validateOpenShellCliEnvironment } from './openshell-cli-environment.js';
import type { VerifySymposiumSubscriptionAuth } from './symposium-subscription-native.js';
import type { OwnedSymposiumGateway } from './symposium-owned-gateway.js';
import {
  attendSubscriptionLogin,
  SymposiumSubscriptionProvisioner,
} from './symposium-subscription-provisioner.js';

export interface SymposiumSubscriptionHostOptions {
  gateway: OwnedSymposiumGateway;
  seatProof: {
    assertCurrent(input: Parameters<VerifySymposiumSubscriptionAuth>[0]): void;
    verify: VerifySymposiumSubscriptionAuth;
  };
  /** Raw WORK profile configuration, never a legacy personal credential reference. */
  workProfiles: readonly unknown[];
  accountId: string;
  label: string;
  selectedModel: string;
  /** Explicit reviewed catalog; this adapter neither guesses nor calls a model. */
  models: readonly CatalogModel[];
}

export function createSymposiumSubscriptionHost(
  options: SymposiumSubscriptionHostOptions,
  runProcess: typeof spawnSync = spawnSync,
) {
  const { gateway } = options;
  const models = options.models.map((model) => CatalogModel.strict().parse(model));
  if (
    !/^[a-zA-Z0-9_-]+$/.test(options.accountId) ||
    !options.label.trim() ||
    models.filter((model) => model.id === options.selectedModel).length !== 1 ||
    new Set(models.map((model) => model.id)).size !== models.length
  )
    throw new Error('An explicit available personal model and account identity are required');
  const work = structuredClone(options.workProfiles);
  if (
    work.some(
      (profile) =>
        !profile ||
        typeof profile !== 'object' ||
        (profile as { provider?: string }).provider === 'openai-codex' ||
        (profile as { id?: string }).id === options.accountId,
    )
  )
    throw new Error('Subscription host accepts distinct WORK profiles only');
  const workProfiles = new AccountProfiles(work, { codexEnabled: true });
  const environment = validateOpenShellCliEnvironment(gateway.managementEnvironment);
  let active = workProfiles;
  let staged: AccountProfiles | undefined;
  const service = new SymposiumSubscriptionProvisioner({
    workspace: gateway.workspace,
    verifyCustody() {
      gateway.verifyCustody();
    },
    async run(args, secrets = {}) {
      gateway.verifyCustody();
      if (
        args[0] !== 'provider' ||
        Object.keys(secrets).some(
          (key) =>
            ![
              'CODEX_AUTH_ACCESS_TOKEN',
              'CODEX_AUTH_ACCOUNT_ID',
              'CODEX_AUTH_REFRESH_TOKEN',
            ].includes(key),
        )
      )
        throw new Error('Invalid subscription management operation');
      const result = runProcess(
        gateway.cli,
        [
          'provider',
          '--gateway',
          gateway.gateway,
          '--workspace',
          gateway.workspace,
          ...args.slice(1),
        ],
        {
          env: { ...environment, ...secrets },
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: 1_000_000,
        },
      );
      gateway.verifyCustody();
      if (result.error || result.status !== 0)
        throw new Error('Subscription management operation failed');
      if (args[1] !== 'list') return undefined;
      try {
        return JSON.parse(String(result.stdout));
      } catch {
        throw new Error('Subscription provider inventory is invalid');
      }
    },
    async installProfile(identity) {
      staged = new AccountProfiles(
        [
          ...work,
          {
            id: options.accountId,
            label: options.label,
            provider: 'openai-codex',
            nativeAuth: 'sandbox-chatgpt',
            email: identity.email,
            planType: identity.planType,
            sandboxProvider: identity.provider,
            sandboxProviderType: 'codex',
            sandboxProviderId: identity.providerId,
            models,
          },
        ],
        { codexEnabled: true },
      );
      return staged.resolve(options.accountId, options.selectedModel);
    },
  });
  const invalidate = () => {
    service.invalidate();
    active = workProfiles;
    staged = undefined;
  };
  const assertSelection = (input: Parameters<VerifySymposiumSubscriptionAuth>[0]) => {
    const binding = input.execution.seat.accountBinding;
    if (!binding || input.route.kind !== 'chatgpt-subscription-native')
      throw new Error('Personal subscription selection is missing');
    const selected = active.resolve(binding.accountId, binding.model);
    if (
      selected.provider !== 'openai-codex' ||
      selected.profileRevision !== binding.profileRevision ||
      input.route.model !== binding.model ||
      input.route.profile.model !== binding.model
    )
      throw new Error('Personal subscription selection changed');
  };

  return {
    get currentProfiles(): AccountProfiles {
      try {
        gateway.verifyCustody();
      } catch {
        invalidate();
      }
      return active;
    },
    verifyPrivateAuth: async (input: Parameters<VerifySymposiumSubscriptionAuth>[0]) => {
      assertSelection(input);
      service.assertPrivateAuth(input);
      await options.seatProof.verify(input);
      assertSelection(input);
      service.assertPrivateAuth(input);
    },
    assertPrivateAuth: (input: Parameters<VerifySymposiumSubscriptionAuth>[0]) => {
      assertSelection(input);
      service.assertPrivateAuth(input);
      options.seatProof.assertCurrent(input);
    },
    invalidate,
    async beginLogin() {
      invalidate();
      const login = await attendSubscriptionLogin(service);
      const completed = login.completed
        .then((result) => {
          gateway.verifyCustody();
          if (!staged) throw new Error('Subscription profile installation did not complete');
          active = staged;
          staged = undefined;
          return result;
        })
        .catch(() => {
          invalidate();
          throw new Error('Personal subscription login did not complete');
        });
      return {
        authorizationUrl: login.authorizationUrl,
        completed,
        cancel() {
          invalidate();
          login.cancel();
        },
      };
    },
  };
}
