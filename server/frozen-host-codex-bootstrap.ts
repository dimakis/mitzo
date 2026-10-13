import { z } from 'zod';
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
import type {
  OrdinaryLocalCodexAdmissionExpectation,
  OrdinaryLocalCodexBootstrapAuthority,
} from './ordinary-local-codex-admission.js';

const Runtime = z.strictObject({
  hostId: z.string().min(1).max(200),
  runtimeContractRevision: z.string().min(1).max(200),
  targetId: z.string().min(1).max(200),
  targetRevision: z.string().min(1).max(200),
  executablePath: z.string().min(1).max(4096),
  executableSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type FrozenHostCodexRuntimeObservation = z.infer<typeof Runtime>;
export interface FrozenHostCodexBootstrapLease extends FrozenHostCodexLoginLease<FrozenHostCodexClient> {
  profile: CodexAccountProfile;
  /** Private server-owned custody reference, never public inventory. */
  privateHome: string;
  executableSha256: string;
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
  constructor(
    private readonly owners: {
      loadProfiles(): AccountProfiles;
      observeRuntime(): Promise<FrozenHostCodexRuntimeObservation>;
      /** Independent actual target/native configuration fence; declarations and
       * cached catalog metadata cannot supply this synchronous authority. */
      assertRuntimeCurrentSync(): void;
      assertSelectionCurrent(expected: Readonly<Expected>): Promise<void>;
      assertSelectionCurrentSync(expected: Readonly<Expected>): void;
      signal: AbortSignal;
      privateRoot?: string;
      baseEnv?: NodeJS.ProcessEnv;
      lifecycle?: CodexLifecycleTransport;
      /** Offline tests replace only native transport creation, preserving real custody. */
      launch?: (
        privateHome: string,
        executable: FrozenHostCodexExecutable,
      ) => FrozenHostCodexClient;
    },
  ) {}
  currentLease(): FrozenHostCodexBootstrapLease | undefined {
    return this.#lease;
  }
  private profile(expected: Expected) {
    const profiles = this.owners.loadProfiles();
    const current = profiles.resolve(expected.binding.account.accountId, expected.selection.model);
    if (
      current.provider !== 'openai-codex' ||
      current.profileRevision !== expected.binding.account.profileRevision ||
      !profiles
        .ordinaryLocalCodexAccounts()
        .some(
          (account) =>
            account.accountId === current.accountId &&
            account.profileRevision === current.profileRevision,
        )
    )
      throw unavailable();
    profiles.validateModelSelection(current, expected.selection.model, expected.selection.thinking);
    return profiles.codexProfile(current);
  }
  private assertSync(
    expected: Expected,
    login?: FrozenHostCodexLoginLease<FrozenHostCodexClient>,
    executable?: FrozenHostCodexExecutable,
  ): void {
    this.owners.signal.throwIfAborted();
    this.owners.assertRuntimeCurrentSync();
    this.profile(expected);
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
      runtime.targetRevision !== expected.binding.execution.targetRevision ||
      (executable && runtime.executableSha256 !== executable.sha256)
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
        expected.binding.account.provider !== 'openai-codex'
      )
        throw unavailable();
      const observed = await this.observe(expected);
      this.assertSync(expected);
      if (this.#attempted) throw unavailable();
      if (!claimBeforeBootstrap()) return undefined;
      this.#attempted = true;
      this.assertSync(expected);
      const ownedProfile = this.profile(expected);
      const login = FrozenHostCodexLogin.capture(ownedProfile, {
        privateRoot: this.owners.privateRoot,
        signal: this.owners.signal,
        bootstrapId: expected.bootstrapId,
      });
      const executable = FrozenHostCodexExecutable.capture(
        observed.executablePath,
        login.privateHome,
      );
      if (executable.sha256 !== observed.executableSha256) throw unavailable();
      const launch =
        this.owners.launch ??
        ((home, selected) =>
          CodexAppServerClient.launchIsolated(
            home,
            this.owners.baseEnv,
            this.owners.lifecycle,
            selected,
          ));
      loginLease = await login.connect((home) => {
        this.assertSync(expected, undefined, executable);
        return launch(home, executable);
      });
      const ownedLogin = loginLease;
      const assertCurrentSync = () => {
        try {
          this.assertSync(expected, ownedLogin, executable);
        } catch {
          ownedLogin.close();
          throw unavailable();
        }
      };
      const assertCurrent = async () => {
        try {
          await this.observe(expected, ownedLogin, executable);
          await ownedLogin.assertCurrent();
          assertCurrentSync();
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
          const models = await readCodexModels({
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
          const model = models.find((entry) => entry.id === expected.selection.model);
          if (
            !model ||
            (expected.selection.thinking === null
              ? !!model.reasoningEfforts?.length
              : !model.reasoningEfforts?.includes(expected.selection.thinking))
          )
            throw unavailable();
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
        close: ownedLogin.close,
        assertCurrent,
        assertCurrentSync,
      };
      await assertCurrent();
      return await operation(this.#lease);
    } catch {
      loginLease?.close();
      throw unavailable();
    }
  }
}
