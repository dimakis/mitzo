import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { CredentialReferenceSchema } from './credentials.js';
import { PublicationCredentialCustodian } from './symposium-publication-credentials.js';
import { GithubMainPublication } from './github-main-publication.js';
import {
  MainPublicationAccountSchema,
  RequestGithubMainPublicationSchema,
  type MainPublicationPins,
  type GithubMainMergeCapability,
} from './telos-main-publication-contract.js';
import type {
  NativeMainPublicationCall,
  SelectedGithubMainMerge,
  SelectGithubMainMerge,
} from './telos-main-publication-host.js';

const identifier = z.string().min(1).max(200).regex(/^\S+$/);
export const GithubMainMergeRegistrationSchema = z.strictObject({
  accountId: identifier,
  connectionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  capabilityId: identifier,
  label: z.string().trim().min(1).max(200),
  credentialRef: CredentialReferenceSchema,
  repository: z.string().regex(/^[a-z0-9-]+\/[a-z0-9_.-]+$/),
  repositoryId: z.number().int().positive().safe(),
  repositoryNodeId: identifier,
  publisherLogin: z.string().regex(/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i),
  trustedReviewer: z.string().regex(/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i),
  centaurAppId: z.number().int().positive().safe(),
  requiredChecks: z
    .array(z.string().min(1).max(200))
    .min(1)
    .max(100)
    .refine(
      (checks) => checks.includes('Centaur final LGTM') && new Set(checks).size === checks.length,
    ),
});
export type GithubMainMergeRegistration = z.infer<typeof GithubMainMergeRegistrationSchema>;
type Reason =
  | 'invalid_registration'
  | 'missing_configuration'
  | 'ambiguous_configuration'
  | 'native_changed'
  | 'invalid_native_assertion'
  | 'selection_changed'
  | 'credential_unavailable'
  | 'invalid_intent'
  | 'repository_changed';

/** Stable public status only; no credential reference, native context or cause. */
export class GithubMainMergeSelectionError extends Error {
  readonly code = 'main_merge_unavailable';
  constructor(readonly reason: Reason) {
    super('Configured main merge is unavailable');
  }
}
function unavailable(reason: Reason): never {
  throw new GithubMainMergeSelectionError(reason);
}
function assertVoidSync(assertion: () => unknown) {
  const value = assertion();
  if (value !== undefined) {
    // TS void accepts async/nonvoid callbacks. Reject their authority and drain
    // a possible rejection without awaiting or granting a later dispatch.
    void Promise.resolve(value).catch(() => {});
    unavailable('invalid_native_assertion');
  }
}
function accountScope(binding: NativeMainPublicationCall['accountBinding']) {
  return MainPublicationAccountSchema.parse({
    accountId: binding.accountId,
    provider: binding.provider,
    model: binding.model,
    profileRevision: binding.profileRevision,
  });
}
interface Entry {
  readonly config: Readonly<
    Omit<GithubMainMergeRegistration, 'credentialRef' | 'requiredChecks'>
  > & {
    readonly credentialRef: Readonly<GithubMainMergeRegistration['credentialRef']>;
    readonly requiredChecks: readonly string[];
  };
  readonly revision: number;
  readonly cancel: AbortController;
  active: boolean;
}
export interface GithubMainMergeSelectionOptions {
  readonly custodian: PublicationCredentialCustodian;
  readonly registrations: readonly GithubMainMergeRegistration[];
}

/** Server-owned registration, separate from read/branch/seal grants. No bootstrap,
 * native installer, default credential, new ledger or model execution is supplied.
 * Configuration is immutable for this registry lifetime; replacement uses a new
 * registry and the real installer's active-runtime fence. */
export class GithubMainMergeSelection {
  private readonly entries = new Map<string, Entry>();
  private readonly custodian: PublicationCredentialCustodian;
  private closed = false;

  constructor(options: GithubMainMergeSelectionOptions) {
    if (!(options.custodian instanceof PublicationCredentialCustodian))
      unavailable('invalid_registration');
    this.custodian = options.custodian;
    const parsed = z
      .array(GithubMainMergeRegistrationSchema)
      .max(128)
      .safeParse(options.registrations);
    if (!parsed.success) unavailable('invalid_registration');
    const occupied = new Set(this.custodian.list().map((entry) => entry.id));
    const ids = parsed.data.map((entry) => entry.connectionId);
    if (new Set(ids).size !== ids.length || ids.some((id) => occupied.has(id)))
      unavailable('invalid_registration');
    for (const registration of parsed.data) {
      const config = Object.freeze({
        ...registration,
        credentialRef: Object.freeze({ ...registration.credentialRef }),
        requiredChecks: Object.freeze([...registration.requiredChecks]),
      });
      this.custodian.register(config.connectionId, config.label, { ...config.credentialRef });
      const metadata = this.custodian.list().find((entry) => entry.id === config.connectionId);
      if (!metadata) unavailable('invalid_registration');
      this.entries.set(config.connectionId, {
        config,
        revision: metadata.revision,
        cancel: new AbortController(),
        active: true,
      });
    }
  }
  private matching(accountId: string) {
    return [...this.entries.values()].filter(
      (entry) => entry.active && entry.config.accountId === accountId,
    );
  }
  /** Eligibility only: never reads a credential or chooses a first/default entry. */
  supportsAccount(accountId: string): boolean {
    return !this.closed && typeof accountId === 'string' && this.matching(accountId).length === 1;
  }
  disconnect(connectionId: string): void {
    const entry = this.entries.get(connectionId);
    if (!entry) unavailable('selection_changed');
    if (!entry.active) return;
    entry.active = false;
    entry.cancel.abort();
    // Do not disconnect a successor owned by another registration/revision.
    if (
      this.custodian
        .list()
        .some((current) => current.id === connectionId && current.revision === entry.revision)
    )
      this.custodian.disconnect(connectionId, entry.revision);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const id of this.entries.keys()) this.disconnect(id);
  }
  bind(context: NativeMainPublicationCall): SelectGithubMainMerge {
    const account = structuredClone(accountScope(context.accountBinding));
    const nativeAssert = context.assertCurrentSync.bind(context);
    const nativeSignal = context.signal;
    const nativeIdentity = {
      operatorId: context.operatorId,
      conversationId: context.conversationId,
      clientId: context.clientId,
      runtimeId: context.runtimeId,
      session: context.session,
    };
    const assertNative = () => {
      try {
        nativeSignal.throwIfAborted();
        assertVoidSync(nativeAssert);
        if (
          !isDeepStrictEqual(accountScope(context.accountBinding), account) ||
          context.operatorId !== nativeIdentity.operatorId ||
          context.conversationId !== nativeIdentity.conversationId ||
          context.clientId !== nativeIdentity.clientId ||
          context.runtimeId !== nativeIdentity.runtimeId ||
          context.session !== nativeIdentity.session ||
          context.signal !== nativeSignal
        )
          unavailable('native_changed');
      } catch (error) {
        if (error instanceof GithubMainMergeSelectionError) throw error;
        unavailable('native_changed');
      }
    };
    assertNative();
    return async (raw, signal): Promise<SelectedGithubMainMerge> => {
      if (!RequestGithubMainPublicationSchema.safeParse(raw).success) unavailable('invalid_intent');
      assertNative();
      if (signal.aborted) unavailable('native_changed');
      const matches = this.closed ? [] : this.matching(account.accountId);
      if (!matches.length) unavailable('missing_configuration');
      if (matches.length !== 1) unavailable('ambiguous_configuration');
      const entry = matches[0]!;
      const config = entry.config;
      const combined = AbortSignal.any([signal, nativeSignal, entry.cancel.signal]);
      const assertEntry = () => {
        assertNative();
        if (combined.aborted) unavailable('selection_changed');
        const current = this.matching(account.accountId);
        if (
          this.closed ||
          !entry.active ||
          this.entries.get(config.connectionId) !== entry ||
          current.length !== 1 ||
          current[0] !== entry
        )
          unavailable('selection_changed');
      };
      assertEntry();
      let handle: Awaited<ReturnType<PublicationCredentialCustodian['select']>>;
      try {
        handle = await this.custodian.select(config.connectionId, entry.revision);
      } catch {
        unavailable('credential_unavailable');
      }
      const original = handle;
      const assertCurrentSync = () => {
        assertEntry();
        if (
          original.connectionId !== config.connectionId ||
          original.revision !== entry.revision ||
          this.custodian.resolve(original.connectionId, original.revision, original.generation) !==
            original
        )
          unavailable('selection_changed');
        if (original.assertCurrent() !== true) unavailable('selection_changed');
      };
      assertCurrentSync();
      const read = async (program: string, args: readonly string[], requestSignal: AbortSignal) => {
        assertCurrentSync();
        if (program !== 'gh') unavailable('selection_changed');
        const response = await original.run('gh', args, AbortSignal.any([requestSignal, combined]));
        assertCurrentSync();
        return { ...response, stderr: '' };
      };
      const adapter = new GithubMainPublication(
        {
          connectionId: config.connectionId,
          capabilityId: config.capabilityId,
          repository: config.repository,
          publisherLogin: config.publisherLogin,
          trustedReviewer: config.trustedReviewer,
          centaurAppId: config.centaurAppId,
          requiredChecks: [...config.requiredChecks],
        },
        read,
        async (_program, args, requestSignal, admit) => {
          assertCurrentSync();
          const response = await this.custodian.dispatchMainMerge(
            original,
            args,
            AbortSignal.any([requestSignal, combined]),
            () => {
              assertCurrentSync();
              admit();
              assertCurrentSync();
            },
          );
          // Known response custody precedes later currentness/cancellation checks.
          // The real adapter validates immutable pins and appends its original ACK.
          return { ...response, stderr: '' };
        },
      );
      const assertPins = (pins: MainPublicationPins, write = false) => {
        assertCurrentSync();
        if (
          pins.authority.operatorId !== nativeIdentity.operatorId ||
          pins.authority.conversationId !== nativeIdentity.conversationId ||
          !isDeepStrictEqual(pins.authority.accountBinding, account) ||
          pins.resource.repositoryId !== config.repositoryId ||
          pins.resource.repositoryNodeId !== config.repositoryNodeId ||
          (write && pins.authority.runtimeId !== nativeIdentity.runtimeId)
        )
          unavailable('repository_changed');
      };
      const capability: GithubMainMergeCapability = Object.freeze<GithubMainMergeCapability>({
        kind: adapter.kind,
        connectionId: adapter.connectionId,
        capabilityId: adapter.capabilityId,
        repository: adapter.repository,
        async resolveResource(input, requestSignal) {
          assertCurrentSync();
          const resource = await adapter.resolveResource(
            input,
            AbortSignal.any([requestSignal, combined]),
          );
          assertCurrentSync();
          if (
            resource.repositoryId !== config.repositoryId ||
            resource.repositoryNodeId !== config.repositoryNodeId
          )
            unavailable('repository_changed');
          return resource;
        },
        async inspect(pins, requestSignal) {
          assertPins(pins);
          const result = await adapter.inspect(pins, AbortSignal.any([requestSignal, combined]));
          assertCurrentSync();
          return result;
        },
        merge(pins, requestSignal, admit, acknowledge) {
          assertPins(pins, true);
          return adapter.merge(
            pins,
            AbortSignal.any([requestSignal, combined]),
            admit,
            acknowledge,
          );
        },
      });
      return Object.freeze({ capability, signal: combined, assertCurrentSync });
    };
  }
}
