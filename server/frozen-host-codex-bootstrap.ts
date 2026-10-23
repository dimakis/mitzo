import type { ApiHarnessConnection } from './account-harness-connection.js';
import { findNativeMacExecutionUnavailable } from './codex-native-artifact-qualification.js';
import { z } from 'zod';
import { observeLocalCodexPhase } from './local-codex-observation.js';
import type { AccountBinding } from '@mitzo/protocol';
import { isDeepStrictEqual } from 'node:util';
import { custodianControllerMode } from './symposium-custodian-mode.js';
import type { AccountProfiles } from './account-profiles.js';
import type { CodexAccountProfile } from './codex-account.js';
import { CodexAppServerClient, type CodexLifecycleTransport } from './codex-app-server-client.js';
import { codexRuntimeOverrides } from './codex-runtime-policy.js';
import { FrozenHostCodexExecutable } from './frozen-host-codex-executable.js';
import {
  FrozenHostCodexLogin,
  type FrozenHostCodexClient,
  type FrozenHostCodexLoginLease,
} from './frozen-host-codex-login.js';
import { readCodexModels } from './model-catalog.js';
import { FrozenHostCodexApiLogin } from './frozen-host-codex-api-login.js';
import { openAIAccountKeyAuthority } from './openai-account-key-authority.js';
import type {
  OrdinaryLocalCodexAdmissionExpectation,
  OrdinaryLocalCodexBootstrapAuthority,
} from './ordinary-local-codex-admission.js';

import {
  HostCodexCustodySchema,
  type HostCodexCustody,
  type HostCodexAuthenticationCustody,
  type HostCodexExecutableCustody,
} from './host-codex-custody.js';
import { join } from 'node:path';
import { codexPrivateDirectory } from './codex-private-path.js';
const Runtime = z.strictObject({
  hostId: z.string().min(1).max(200),
  runtimeContractRevision: z.string().min(1).max(200),
  targetId: z.string().min(1).max(200),
  targetRevision: z.string().min(1).max(200),
  compatibleTargetRevisions: z.array(z.string().min(1).max(200)).max(8).optional(),
  executablePath: z.string().min(1).max(4096),
  executableSha256: z.string().regex(/^[a-f0-9]{64}$/),
  codeModeHostSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type FrozenHostCodexRuntimeObservation = z.infer<typeof Runtime>;
export interface FrozenHostCodexBootstrapLease extends FrozenHostCodexLoginLease<FrozenHostCodexClient> {
  profile: CodexAccountProfile;
  /** Private server-owned custody reference, never public inventory. */
  privateHome: string;
  executableSha256: string;
  assertModelSelectionCurrentSync?(model: string, thinking: string | null): void;
  assertToolCurrent?(signal: AbortSignal): Promise<void>;
  qualifyModelSelection?(model: string, thinking: string | null): Promise<void>;
  custodySnapshot?(): {
    login: HostCodexAuthenticationCustody;
    executable: HostCodexExecutableCustody;
  };
}
type Expected = OrdinaryLocalCodexAdmissionExpectation & { bootstrapId?: string };
const unavailable = () => new Error('Host Codex bootstrap unavailable');

/** Actual owned client bootstrap. The surrounding server factory must connect
 * independent current operator, published profile/context, permission and
 * workspace reservation authorities to BOTH selection fences. Those callbacks
 * cannot be implemented from the capability catalog or request declarations.
 * This class adds no account/workspace/command registry and no automatic replay.
 */
export class FrozenHostCodexBootstrapAuthority implements OrdinaryLocalCodexBootstrapAuthority {
  #lease?: FrozenHostCodexBootstrapLease;
  #attempted = false;
  #routingBinding?: AccountBinding;
  constructor(
    private readonly owners: {
      loadProfiles(): AccountProfiles;
      observeRuntime(): Promise<FrozenHostCodexRuntimeObservation>;
      /** Independent actual target/native configuration fence; declarations and
       * cached catalog metadata cannot supply this synchronous authority. */
      assertRuntimeCurrentSync(): void;
      assertSelectionCurrent(expected: Readonly<Expected>): Promise<void>;
      /** Current physical checkout only; full preparation was qualified at bootstrap. */
      assertToolSelectionCurrent?(expected: Readonly<Expected>): Promise<void>;
      assertSelectionCurrentSync(expected: Readonly<Expected>): void;
      signal: AbortSignal;
      privateRoot?: string;
      /** Native ledger evidence, supplied only by the original cold-resume owner. */
      retainedCustody?: HostCodexCustody;
      completeRetainedRuntimeBundle?(executable: FrozenHostCodexExecutable): void;
      /** Native history retains its original model-keyed binding independently of command settings. */
      retainedAccountBinding?: AccountBinding;
      /** Completed history is not a current inference allowlist. */
      isSelectionPending?(): boolean;
      pendingSelections?(): Array<{ model: string; thinking: string | null }>;
      baseEnv?: NodeJS.ProcessEnv;
      lifecycle?: CodexLifecycleTransport;
      /** Offline tests replace only native transport creation, preserving real custody. */
      launch?: (
        privateHome: string,
        executable: FrozenHostCodexExecutable,
      ) => FrozenHostCodexClient;
      launchApi?: (
        privateHome: string,
        executable: FrozenHostCodexExecutable,
        binding: AccountBinding,
        retained: boolean,
        connection?: ApiHarnessConnection,
      ) => Promise<FrozenHostCodexClient>;
    },
  ) {}
  currentLease(): FrozenHostCodexBootstrapLease | undefined {
    return this.#lease;
  }
  private profile(expected: Expected) {
    const profiles = this.owners.loadProfiles();
    const historical = this.owners.isSelectionPending?.() === false && this.#routingBinding;
    const current = historical
      ? profiles.resumeRouting(this.#routingBinding!)
      : profiles.resolve(expected.binding.account.accountId, expected.selection.model);
    if (
      current.provider !== expected.binding.account.provider ||
      !['openai', 'openai-codex'].includes(current.provider) ||
      current.profileRevision !== expected.binding.account.profileRevision ||
      (current.provider === 'openai-codex' &&
        !profiles
          .ordinaryLocalCodexAccounts()
          .some(
            (account) =>
              account.accountId === current.accountId &&
              account.profileRevision === current.profileRevision,
          ))
    )
      throw unavailable();
    if (!historical)
      profiles.validateModelSelection(
        current,
        expected.selection.model,
        expected.selection.thinking,
      );
    return profiles.localCodexProfile(current, !!historical);
  }
  private selections(expected: Expected): Array<{ model: string; thinking: string | null }> {
    return [
      ...(this.owners.isSelectionPending?.() === false
        ? []
        : [{ model: expected.selection.model, thinking: expected.selection.thinking }]),
      ...(this.owners.pendingSelections?.() ?? []),
    ];
  }
  private assertSync(
    expected: Expected,
    login?: FrozenHostCodexLoginLease<FrozenHostCodexClient>,
    executable?: FrozenHostCodexExecutable,
  ): void {
    this.owners.signal.throwIfAborted();
    this.owners.assertRuntimeCurrentSync();
    this.profile(expected);
    const profiles = this.owners.loadProfiles();
    for (const selection of this.selections(expected)) {
      const binding = profiles.resolve(expected.binding.account.accountId, selection.model);
      if (
        binding.provider !== expected.binding.account.provider ||
        binding.profileRevision !== expected.binding.account.profileRevision
      )
        throw unavailable();
      profiles.validateModelSelection(binding, selection.model, selection.thinking);
    }
    this.owners.assertSelectionCurrentSync(structuredClone(expected));
    login?.assertCurrentSync();
    executable?.assertCurrent();
  }
  private async observe(
    expected: Expected,
    login?: FrozenHostCodexLoginLease<FrozenHostCodexClient>,
    executable?: FrozenHostCodexExecutable,
  ) {
    this.assertSync(expected, login, executable);
    await this.owners.assertSelectionCurrent(structuredClone(expected));
    this.assertSync(expected, login, executable);
    const runtime = Runtime.parse(await this.owners.observeRuntime());
    this.assertSync(expected, login, executable);
    if (
      runtime.hostId !== expected.hostId ||
      runtime.runtimeContractRevision !== expected.runtimeContractRevision ||
      runtime.targetId !== expected.binding.execution.targetId ||
      (runtime.targetRevision !== expected.binding.execution.targetRevision &&
        !runtime.compatibleTargetRevisions?.includes(expected.binding.execution.targetRevision)) ||
      (executable &&
        (runtime.executableSha256 !== executable.sha256 ||
          (runtime.codeModeHostSha256 !== undefined &&
            runtime.codeModeHostSha256 !== executable.custodySnapshot().codeModeHost?.sha256)))
    )
      throw unavailable();
    return runtime;
  }
  async withBootstrap<T>(
    expectedInput: Readonly<Expected>,
    claimBeforeBootstrap: () => boolean,
    operation: (lease: FrozenHostCodexBootstrapLease) => Promise<T>,
  ): Promise<T | undefined> {
    let loginLease: FrozenHostCodexLoginLease<FrozenHostCodexClient> | undefined;
    try {
      if (custodianControllerMode) throw unavailable();
      const expected = structuredClone(expectedInput);
      if (
        !expected.bootstrapId ||
        !/^[a-f0-9]{64}$/.test(expected.bootstrapId) ||
        this.#attempted ||
        expected.binding.harness.implementation !== 'codex' ||
        expected.binding.execution.location !== 'local' ||
        !['openai-codex', 'openai'].includes(expected.binding.account.provider)
      )
        throw unavailable();
      const observed = await this.observe(expected);
      this.assertSync(expected);
      if (this.#attempted) throw unavailable();
      if (!claimBeforeBootstrap()) return undefined;
      this.#attempted = true;
      this.assertSync(expected);
      let ownedProfile = this.profile(expected);
      if (this.owners.retainedAccountBinding) {
        if (!this.owners.retainedCustody) throw unavailable();
        const original = this.owners.retainedAccountBinding;
        const selected = this.owners
          .loadProfiles()
          .resolve(expected.binding.account.accountId, expected.selection.model);
        const identity = (binding: AccountBinding) => ({
          accountId: binding.accountId,
          provider: binding.provider,
          profileRevision: binding.profileRevision,
        });
        if (!isDeepStrictEqual(identity(original), identity(selected))) throw unavailable();
        // model belongs to native history identity here; every actual turn uses
        // independently qualified expected.selection, with no inference fallback.
        ownedProfile = {
          ...ownedProfile,
          accountLabel: original.accountLabel,
          model: original.model,
        };
      }
      const retained = this.owners.retainedCustody
        ? HostCodexCustodySchema.parse(this.owners.retainedCustody)
        : undefined;
      const api = expected.binding.account.provider === 'openai';
      const retainedApi = retained && 'kind' in retained.login && retained.login.kind === 'api-key';
      if (retained && !!retainedApi !== api) throw unavailable();
      if (
        retained &&
        (retained.login.privateHome !==
          join(
            this.owners.privateRoot ?? codexPrivateDirectory(),
            `${api ? 'host-api' : 'host-login'}-${retained.bootstrapId}`,
          ) ||
          retained.executable.path !== join(retained.login.privateHome, 'codex-runtime') ||
          retained.executable.source !== observed.executablePath)
      )
        throw unavailable();
      const authBinding =
        this.owners.retainedAccountBinding ??
        this.owners.loadProfiles().resolve(expected.binding.account.accountId, ownedProfile.model);
      const connection = api
        ? this.owners.loadProfiles().apiRoutingProfile(authBinding).connection
        : undefined;
      const selectedConnection = api
        ? this.owners.loadProfiles().harnessConnection(authBinding)
        : undefined;
      const endpoint =
        selectedConnection?.authentication === 'api-key' ? selectedConnection.endpoint : undefined;
      const keyAuthority = api
        ? openAIAccountKeyAuthority(authBinding, this.owners.loadProfiles(), {
            consumer: 'host',
            endpoint,
          })
        : undefined;
      const login = api
        ? retained
          ? await FrozenHostCodexApiLogin.reopen(
              authBinding,
              retained.login,
              keyAuthority!,
              this.owners.signal,
            )
          : await FrozenHostCodexApiLogin.capture(authBinding, {
              privateRoot: this.owners.privateRoot,
              bootstrapId: expected.bootstrapId,
              authority: keyAuthority!,
              signal: this.owners.signal,
            })
        : retained
          ? FrozenHostCodexLogin.reopen(ownedProfile, retained.login, this.owners.signal)
          : FrozenHostCodexLogin.capture(ownedProfile, {
              privateRoot: this.owners.privateRoot,
              signal: this.owners.signal,
              bootstrapId: expected.bootstrapId,
            });
      const executable = retained
        ? FrozenHostCodexExecutable.reopen(retained.executable)
        : FrozenHostCodexExecutable.capture(observed.executablePath, login.privateHome);
      if (retained && executable.companionUpgradePlan()) {
        if (!this.owners.completeRetainedRuntimeBundle) throw unavailable();
        this.owners.completeRetainedRuntimeBundle(executable);
        this.assertSync(expected, undefined, executable);
      }
      if (executable.sha256 !== observed.executableSha256) throw unavailable();
      if (
        observed.codeModeHostSha256 !== undefined &&
        executable.custodySnapshot().codeModeHost?.sha256 !== observed.codeModeHostSha256
      )
        throw unavailable();
      const launch =
        this.owners.launch ??
        ((home, selected) =>
          CodexAppServerClient.launchIsolated(
            home,
            this.owners.baseEnv,
            this.owners.lifecycle,
            selected,
          ));
      loginLease =
        login instanceof FrozenHostCodexApiLogin
          ? await login.connect(async (home) => {
              this.assertSync(expected, undefined, executable);
              if (this.owners.launchApi)
                return this.owners.launchApi(home, executable, authBinding, !!retained, connection);
              if (!this.owners.lifecycle) throw unavailable();
              if (retained)
                return CodexAppServerClient.launchIsolatedApiResume(
                  home,
                  this.owners.baseEnv,
                  this.owners.lifecycle,
                  executable,
                  connection,
                );
              const result = await CodexAppServerClient.launchIsolatedApi({
                privateHome: home,
                executable,
                binding: authBinding,
                connection,
                signal: this.owners.signal,
                lifecycle: this.owners.lifecycle,
                base: this.owners.baseEnv,
                resolveKey: (binding, signal) =>
                  keyAuthority!.resolveKey(binding.accountId, signal),
                assertCurrent: async () => {
                  this.assertSync(expected, undefined, executable);
                  await keyAuthority!.assertReady(this.owners.signal);
                  this.assertSync(expected, undefined, executable);
                },
              });
              return result.client;
            })
          : await login.connect((home) => {
              this.assertSync(expected, undefined, executable);
              return launch(home, executable);
            });
      const ownedLogin = loginLease;
      this.#routingBinding = structuredClone(ownedLogin.binding);
      const assertCurrentSync = () => {
        try {
          this.assertSync(expected, ownedLogin, executable);
        } catch {
          ownedLogin.close();
          throw unavailable();
        }
      };
      let qualifiedModels: Array<{ id: string; reasoningEfforts?: string[] }> = [];
      const assertToolCurrent = async (signal: AbortSignal = this.owners.signal) => {
        try {
          signal.throwIfAborted();
          assertCurrentSync();
          await observeLocalCodexPhase('workspace_check', () =>
            (this.owners.assertToolSelectionCurrent ?? this.owners.assertSelectionCurrent)(
              expected,
            ),
          );
          await observeLocalCodexPhase('credential_check', () =>
            ownedLogin.assertCredentialCurrent
              ? ownedLogin.assertCredentialCurrent(signal)
              : ownedLogin.assertCurrent(),
          );
          signal.throwIfAborted();
          assertCurrentSync();
        } catch {
          ownedLogin.close();
          throw unavailable();
        }
      };
      const qualifyModels = async (
        selections: Array<{ model: string; thinking: string | null }>,
      ) => {
        try {
          await assertToolCurrent();
          const config = await ownedLogin.client.request('config/read', {
            // Bootstrap does not create the reserved checkout. Inspect only
            // this real private home; CodexConversation separately validates
            // actual workspace config before its guarded thread/turn effects.
            cwd: login.privateHome,
            includeLayers: false,
          });
          assertCurrentSync();
          if (Buffer.byteLength(JSON.stringify(config), 'utf8') > 256 * 1024) throw unavailable();
          codexRuntimeOverrides(
            z.object({ config: z.unknown() }).parse(config).config,
            this.profile(expected).workspaceId,
          );
          let pages = 0;
          // Custom endpoints use their operator-qualified configured catalog.
          // Native model/list is an OpenAI catalog, not gateway capability evidence.
          const models = connection
            ? this.owners
                .loadProfiles()
                .catalog()
                .find((account) => account.id === authBinding.accountId)!.models
            : await readCodexModels({
                request: async (method, params) => {
                  if (++pages > 16) throw unavailable();
                  const response = await ownedLogin.client.request(method, params);
                  assertCurrentSync();
                  if (Buffer.byteLength(JSON.stringify(response), 'utf8') > 1024 * 1024)
                    throw unavailable();
                  z.object({
                    data: z.array(z.unknown()).max(100),
                    nextCursor: z.string().min(1).max(200).nullable().optional(),
                  }).parse(response);
                  return response;
                },
              });
          assertCurrentSync();
          for (const selection of selections) {
            const profiles = this.owners.loadProfiles();
            profiles.validateModelSelection(
              profiles.resolve(expected.binding.account.accountId, selection.model),
              selection.model,
              selection.thinking,
            );
            const model = models.find((entry) => entry.id === selection.model);
            if (
              !model ||
              (selection.thinking === null
                ? !!model.reasoningEfforts?.length
                : !model.reasoningEfforts?.includes(selection.thinking))
            )
              throw unavailable();
          }
          qualifiedModels = models;
        } catch {
          ownedLogin.close();
          throw unavailable();
        }
      };
      this.#lease = {
        get profile() {
          return structuredClone(ownedProfile);
        },
        client: ownedLogin.client,
        get binding() {
          return structuredClone(ownedLogin.binding);
        },
        privateHome: login.privateHome,
        executableSha256: executable.sha256,
        assertModelSelectionCurrentSync: (model, thinking) => {
          assertCurrentSync();
          this.owners.loadProfiles().validateModelSelection(ownedLogin.binding, model, thinking);
          const supported = qualifiedModels.find((entry) => entry.id === model);
          if (
            !supported ||
            (thinking === null
              ? !!supported.reasoningEfforts?.length
              : !supported.reasoningEfforts?.includes(thinking))
          )
            throw unavailable();
        },
        custodySnapshot: () => ({
          login: login.custodySnapshot(),
          executable: executable.custodySnapshot(),
        }),
        close: ownedLogin.close,
        assertCurrent: assertToolCurrent,
        assertToolCurrent,
        qualifyModelSelection: (model, thinking) =>
          observeLocalCodexPhase('model_qualification', () =>
            qualifyModels([{ model, thinking }, ...this.selections(expected)]),
          ),
        assertCurrentSync,
      };
      await observeLocalCodexPhase('model_qualification', () =>
        qualifyModels(this.selections(expected)),
      );
      return await operation(this.#lease);
    } catch (error) {
      loginLease?.close();
      const capabilityError = findNativeMacExecutionUnavailable(error);
      if (capabilityError) throw capabilityError;
      throw unavailable();
    }
  }
}
