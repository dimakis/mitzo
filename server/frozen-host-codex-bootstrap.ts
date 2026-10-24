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
/** Private original-bootstrap current owner for one anchored physical workspace
 * validation. It supplies no roots, custody proof or permission by itself. */
export interface FrozenHostQualifiedWorkspaceReadOwner {
  readonly client: FrozenHostCodexClient;
  readonly binding: Readonly<AccountBinding>;
  readonly signal: AbortSignal;
  assertCurrentSync(): void;
  revalidate(): Promise<void>;
}
export interface FrozenHostCodexBootstrapLease extends FrozenHostCodexLoginLease<FrozenHostCodexClient> {
  profile: CodexAccountProfile;
  /** Private server-owned custody reference, never public inventory. */
  privateHome: string;
  executableSha256: string;
  withQualifiedWorkspaceReadOwner?(
    signal: AbortSignal,
    physical: (owner: FrozenHostQualifiedWorkspaceReadOwner) => Promise<void>,
  ): Promise<void>;
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
function strictVoid(result: unknown): void {
  if (result === undefined) return;
  void Promise.resolve(result).catch(() => {});
  throw unavailable();
}

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
  readonly #coldOwner?: {
    signal: AbortSignal;
    custody?: HostCodexCustody;
    snapshot?: HostCodexCustody;
    references: Record<string, PropertyDescriptor | undefined>;
  };
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
      /** Private clean-qualified cold entry only. This independent authority
       * defers the recursive async workspace stage until the real lease exists;
       * mandatory assertToolSelectionCurrent still runs before config/models. */
      assertQualifiedColdSelectionBeforeBootstrapSync?(expected: Readonly<Expected>): void;
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
  ) {
    if ('assertQualifiedColdSelectionBeforeBootstrapSync' in owners) {
      this.#coldOwner = {
        signal: owners.signal,
        custody: owners.retainedCustody,
        snapshot: owners.retainedCustody && structuredClone(owners.retainedCustody),
        references: Object.fromEntries(
          [
            'loadProfiles',
            'observeRuntime',
            'assertRuntimeCurrentSync',
            'assertSelectionCurrentSync',
            'assertSelectionCurrent',
            'assertToolSelectionCurrent',
            'assertQualifiedColdSelectionBeforeBootstrapSync',
            'isSelectionPending',
            'pendingSelections',
            'launch',
            'launchApi',
            'completeRetainedRuntimeBundle',
          ].map((key) => [key, Object.getOwnPropertyDescriptor(owners, key)]),
        ),
      };
    }
  }
  private assertColdOwnerIdentity(): void {
    const original = this.#coldOwner;
    if (!original) {
      if ('assertQualifiedColdSelectionBeforeBootstrapSync' in this.owners) throw unavailable();
      return;
    }
    original.signal.throwIfAborted();
    if (
      this.owners.signal !== original.signal ||
      this.owners.retainedCustody !== original.custody ||
      !isDeepStrictEqual(this.owners.retainedCustody, original.snapshot)
    )
      throw unavailable();
    for (const [key, descriptor] of Object.entries(original.references)) {
      const current = Object.getOwnPropertyDescriptor(this.owners, key);
      if (
        descriptor
          ? !('value' in descriptor) ||
            !current ||
            !('value' in current) ||
            descriptor.value !== current.value
          : current !== undefined
      )
        throw unavailable();
    }
  }
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
    this.assertColdOwnerIdentity();
    this.owners.signal.throwIfAborted();
    strictVoid(this.owners.assertRuntimeCurrentSync());
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
    strictVoid(this.owners.assertSelectionCurrentSync(structuredClone(expected)));
    strictVoid(login?.assertCurrentSync());
    strictVoid(executable?.assertCurrent());
    this.assertColdOwnerIdentity();
  }
  private async observe(
    expected: Expected,
    login?: FrozenHostCodexLoginLease<FrozenHostCodexClient>,
    executable?: FrozenHostCodexExecutable,
  ) {
    this.assertSync(expected, login, executable);
    strictVoid(
      await Reflect.apply(this.owners.assertSelectionCurrent, this.owners, [
        structuredClone(expected),
      ]),
    );
    this.assertSync(expected, login, executable);
    const runtime = Runtime.parse(await this.owners.observeRuntime());
    this.assertSync(expected, login, executable);
    this.assertRuntimeObservation(expected, runtime, executable);
    return runtime;
  }
  private assertRuntimeObservation(
    expected: Expected,
    runtime: FrozenHostCodexRuntimeObservation,
    executable?: FrozenHostCodexExecutable,
  ): void {
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
  }
  private async observeQualifiedColdBeforeBootstrap(expected: Expected) {
    const owners = this.owners;
    const original = owners.assertQualifiedColdSelectionBeforeBootstrapSync;
    const signal = owners.signal;
    const custody = owners.retainedCustody;
    const references = Object.fromEntries(
      [
        'assertRuntimeCurrentSync',
        'assertSelectionCurrentSync',
        'assertToolSelectionCurrent',
        'assertSelectionCurrent',
        'observeRuntime',
        'loadProfiles',
      ].map((key) => [key, Object.getOwnPropertyDescriptor(owners, key)]),
    );
    const retained = custody && structuredClone(custody);
    if (typeof original !== 'function' || !custody || !owners.assertToolSelectionCurrent)
      throw unavailable();
    HostCodexCustodySchema.parse(custody);
    const referencesCurrent = () => {
      if (
        owners !== this.owners ||
        owners.signal !== signal ||
        owners.retainedCustody !== custody ||
        !isDeepStrictEqual(custody, retained) ||
        owners.assertQualifiedColdSelectionBeforeBootstrapSync !== original
      )
        throw unavailable();
      for (const [key, descriptor] of Object.entries(references)) {
        const current = Object.getOwnPropertyDescriptor(owners, key);
        if (
          !descriptor ||
          !('value' in descriptor) ||
          !current ||
          !('value' in current) ||
          descriptor.value !== current.value
        )
          throw unavailable();
      }
    };
    const current = () => {
      referencesCurrent();
      this.assertSync(expected);
      referencesCurrent();
    };
    current();
    strictVoid(Reflect.apply(original, owners, [structuredClone(expected)]));
    current();
    const runtime = Runtime.parse(await owners.observeRuntime());
    current();
    this.assertRuntimeObservation(expected, runtime);
    return runtime;
  }
  async withBootstrap<T>(
    expectedInput: Readonly<Expected>,
    claimBeforeBootstrap: () => boolean,
    operation: (lease: FrozenHostCodexBootstrapLease) => Promise<T>,
  ): Promise<T | undefined> {
    return observeLocalCodexPhase('bootstrap', () =>
      this.bootstrap(expectedInput, claimBeforeBootstrap, operation),
    );
  }
  private async bootstrap<T>(
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
      const observed = this.owners.assertQualifiedColdSelectionBeforeBootstrapSync
        ? await this.observeQualifiedColdBeforeBootstrap(expected)
        : await this.observe(expected);
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
      let retired = false;
      const loginClose = ownedLogin.close;
      const closeLease = () => {
        retired = true;
        Reflect.apply(loginClose, ownedLogin, []);
      };
      this.#routingBinding = structuredClone(ownedLogin.binding);
      const assertCurrentSync = () => {
        try {
          if (retired) throw unavailable();
          this.assertSync(expected, ownedLogin, executable);
        } catch {
          closeLease();
          throw unavailable();
        }
      };
      let qualifiedModels: Array<{ id: string; reasoningEfforts?: string[] }> = [];
      const assertToolCurrent = async (signal: AbortSignal = this.owners.signal) => {
        try {
          const workspaceCurrent =
            this.owners.assertToolSelectionCurrent ?? this.owners.assertSelectionCurrent;
          const current = () => {
            signal.throwIfAborted();
            assertCurrentSync();
            if (
              (this.owners.assertToolSelectionCurrent ?? this.owners.assertSelectionCurrent) !==
              workspaceCurrent
            )
              throw unavailable();
            for (const [key, original] of Object.entries(loginReferences)) {
              const actual = Object.getOwnPropertyDescriptor(ownedLogin, key);
              if (
                original
                  ? !('value' in original) ||
                    !actual ||
                    !('value' in actual) ||
                    actual.value !== original.value
                  : actual !== undefined
              )
                throw unavailable();
            }
          };
          current();
          strictVoid(
            await observeLocalCodexPhase('workspace_check', () =>
              Reflect.apply(workspaceCurrent, this.owners, [expected]),
            ),
          );
          current();
          if (!full || !('value' in full) || typeof full.value !== 'function') throw unavailable();
          strictVoid(
            await observeLocalCodexPhase('credential_check', () =>
              Reflect.apply(
                full.value,
                ownedLogin,
                loginReferences.assertCredentialCurrent ? [signal] : [],
              ),
            ),
          );
          current();
        } catch {
          closeLease();
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
          closeLease();
          throw unavailable();
        }
      };
      const bootstrapOwners = this.owners;
      const sourceSignal = bootstrapOwners.signal;
      const expectedSnapshot = structuredClone(expected);
      const account = structuredClone(ownedLogin.binding);
      const client = ownedLogin.client;
      const ownerReferences = Object.fromEntries(
        [
          'loadProfiles',
          'observeRuntime',
          'assertRuntimeCurrentSync',
          'assertSelectionCurrentSync',
          'assertSelectionCurrent',
          'assertToolSelectionCurrent',
          'assertQualifiedColdSelectionBeforeBootstrapSync',
          'isSelectionPending',
          'pendingSelections',
        ].map((key) => [key, Object.getOwnPropertyDescriptor(bootstrapOwners, key)]),
      );
      const loginReferences = Object.fromEntries(
        ['assertCurrentSync', 'assertCurrent', 'assertCredentialCurrent', 'close'].map((key) => [
          key,
          Object.getOwnPropertyDescriptor(ownedLogin, key),
        ]),
      );
      const full = loginReferences.assertCredentialCurrent ?? loginReferences.assertCurrent;
      const withQualifiedWorkspaceReadOwner = async (
        operationSignal: AbortSignal,
        physical: (owner: FrozenHostQualifiedWorkspaceReadOwner) => Promise<void>,
      ): Promise<void> => {
        const lease = this.#lease;
        if (
          !lease ||
          !(operationSignal instanceof AbortSignal) ||
          typeof physical !== 'function' ||
          !full ||
          !('value' in full) ||
          typeof full.value !== 'function'
        )
          throw unavailable();
        const lifetime = new AbortController();
        const signal = AbortSignal.any([sourceSignal, operationSignal, lifetime.signal]);
        let live = true;
        const references = () => {
          signal.throwIfAborted();
          if (
            !live ||
            retired ||
            this.#lease !== lease ||
            this.owners !== bootstrapOwners ||
            this.owners.signal !== sourceSignal ||
            lease.client !== client ||
            ownedLogin.client !== client ||
            lease.assertCurrentSync !== assertCurrentSync ||
            lease.assertCurrent !== assertToolCurrent ||
            lease.assertToolCurrent !== assertToolCurrent ||
            lease.close !== closeLease ||
            lease.withQualifiedWorkspaceReadOwner !== withQualifiedWorkspaceReadOwner ||
            !isDeepStrictEqual(expected, expectedSnapshot) ||
            !isDeepStrictEqual(ownedLogin.binding, account) ||
            !isDeepStrictEqual(lease.binding, account)
          )
            throw unavailable();
          for (const [owner, entries] of [
            [bootstrapOwners, ownerReferences],
            [ownedLogin, loginReferences],
          ] as const) {
            for (const [key, original] of Object.entries(entries)) {
              const current = Object.getOwnPropertyDescriptor(owner, key);
              if (
                original
                  ? !('value' in original) ||
                    !current ||
                    !('value' in current) ||
                    current.value !== original.value
                  : current !== undefined
              )
                throw unavailable();
            }
          }
        };
        const current = () => {
          references();
          strictVoid(assertCurrentSync());
          references();
        };
        const revalidate = async () => {
          current();
          strictVoid(
            await Reflect.apply(
              full.value,
              ownedLogin,
              loginReferences.assertCredentialCurrent ? [signal] : [],
            ),
          );
          current();
        };
        try {
          current();
          await revalidate();
          current();
          const owner = Object.freeze({
            client,
            binding: Object.freeze(account),
            signal,
            assertCurrentSync: Object.freeze(current),
            revalidate: Object.freeze(revalidate),
          });
          strictVoid(await Reflect.apply(physical, undefined, [owner]));
          current();
          await revalidate();
          current();
        } catch {
          closeLease();
          throw unavailable();
        } finally {
          live = false;
          lifetime.abort(unavailable());
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
        close: closeLease,
        withQualifiedWorkspaceReadOwner,
        assertCurrent: assertToolCurrent,
        assertToolCurrent,
        qualifyModelSelection: (model, thinking) =>
          observeLocalCodexPhase('model_qualification', () =>
            qualifyModels([{ model, thinking }, ...this.selections(expected)]),
          ),
        assertCurrentSync,
      };
      Object.defineProperty(this.#lease, 'withQualifiedWorkspaceReadOwner', {
        value: withQualifiedWorkspaceReadOwner,
        writable: false,
        configurable: false,
      });
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
