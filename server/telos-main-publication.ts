import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { TelosWorkStore } from './telos-work-store.js';
import {
  RequestGithubMainPublicationSchema,
  MainPublicationAccountSchema,
  MainPublicationResourceSchema,
  normalPrPublicationContract,
  projectMainPublicationResult,
  type GithubMainMergeCapability,
  type MainPublicationAuthority,
  type MainPublicationInput,
  type MainPublicationPins,
  type MainPublicationReceipt,
  type MainPublicationResult,
  type MainPublicationInspection,
} from './telos-main-publication-contract.js';

export const githubMainPublicationTool = {
  name: 'RequestGithubMainPublication',
  description:
    'Request an exact reviewed GitHub PR squash merge for your current Telos work. Approval binds repository, PR, source head, squash and current work authority; main may advance under current normal remote CI/review/strict up-to-date protections. Requires a separately configured selected merge capability and one-use operator approval. Holds and currentness are checked at effect admission. Changed source requires fresh approval. Retain requestId after uncertainty; retry observes the original operation without repeating its merge.',
  input_schema: z.toJSONSchema(RequestGithubMainPublicationSchema),
};
export interface MainPublicationPermission {
  toolName: 'RequestGithubMainPublication';
  pins: MainPublicationPins;
}
/** Composition ports belong to the genuine ordinary host. Approval is its existing
 * exact-input permission owner, never a flag/receipt accepted in native JSON.
 * assertCurrent MUST synchronously revalidate signed operator, account, runtime,
 * connection and configured capability identity at remote-effect admission. */
export interface MainPublicationHost {
  resolve(
    input: MainPublicationInput,
    signal: AbortSignal,
  ): Promise<{
    authority: MainPublicationAuthority;
    capability: GithubMainMergeCapability;
  }>;
  assertCurrent(pins: MainPublicationPins): void;
  approve(
    presentation: MainPublicationPermission,
    signal: AbortSignal,
  ): Promise<{ receiptId: string } | undefined>;
}
const freezePins = (pins: MainPublicationPins): MainPublicationPins =>
  Object.freeze({
    ...pins,
    input: Object.freeze({ ...pins.input }),
    resource: Object.freeze({ ...pins.resource }),
    authority: Object.freeze({
      ...pins.authority,
      accountBinding: Object.freeze({ ...pins.authority.accountBinding }),
    }),
  });

/** No native registration/HTTP route or credentials are installed by this owner. */
export class TelosMainPublication {
  constructor(
    private readonly work: TelosWorkStore,
    private readonly host: MainPublicationHost,
  ) {}

  async request(raw: unknown, signal: AbortSignal): Promise<MainPublicationResult> {
    return projectMainPublicationResult(await this.requestReceipt(raw, signal));
  }
  private async requestReceipt(raw: unknown, signal: AbortSignal): Promise<MainPublicationReceipt> {
    const input = RequestGithubMainPublicationSchema.parse(raw);
    signal.throwIfAborted();
    const resolved = await this.host.resolve(input, signal);
    const authority = {
      ...resolved.authority,
      accountBinding: MainPublicationAccountSchema.parse(resolved.authority.accountBinding),
    };
    const capability = resolved.capability;
    if (
      capability.kind !== 'github-main-merge' ||
      !['repository', 'connectionId', 'capabilityId'].every(
        (key) =>
          capability[key as 'repository' | 'connectionId' | 'capabilityId'] ===
          authority[key as 'repository' | 'connectionId' | 'capabilityId'],
      )
    )
      throw new Error('Separate configured GitHub main merge capability required');
    const records = this.work.mainPublicationsForHost();
    // Recover retained identity before resolving a new name. Never backfill or
    // retag historical uncertainty from a freshly configured repository alias.
    const previous = records.existingForHost(input, authority);
    const receipt =
      previous ??
      records.prepare({
        input,
        contract: normalPrPublicationContract,
        authority,
        resource: MainPublicationResourceSchema.parse(
          await capability.resolveResource(input, signal),
        ),
        baseBranch: 'main',
        method: 'squash',
      });
    const pins = freezePins(receipt.pins);
    if (['accepted', 'denied', 'conflicted'].includes(receipt.state)) return receipt;
    if (receipt.state === 'uncertain') {
      // Historical observation requires the same signed account/connection, but
      // cannot resurrect assignment, runtime, approval or remote-mutation authority.
      try {
        const observation = await capability.inspect(pins, signal);
        if (observation.state === 'accepted') return records.accept(pins, observation);
      } catch {
        /* Keep the original uncertainty, without exposing host diagnostics. */
      }
      return receipt;
    }
    // Historical requested pins cannot acquire the amended permission/effect.
    if (pins.contract !== normalPrPublicationContract) return this.deny(pins);
    let inspectedMainHead: string | undefined;
    try {
      this.host.assertCurrent(pins);
      records.assertWorkCurrent(pins);
      const inspected = await capability.inspect(pins, signal);
      // Another operator's prior merge is not this request's accepted receipt.
      if (inspected.state !== 'ready') return this.deny(pins);
      inspectedMainHead = inspected.mainHead;
      this.assertAdmission(pins, inspected, signal);
      const permission = await this.host.approve(
        {
          toolName: 'RequestGithubMainPublication',
          pins: freezePins(structuredClone(pins)),
        },
        signal,
      );
      if (!permission?.receiptId) return this.deny(pins, inspectedMainHead);
      let admitted = false;
      const observed = await capability.merge(
        pins,
        signal,
        (freshInspection) => {
          if (admitted) throw new Error('Publication remote admission is one-use');
          records.admit(
            pins,
            permission.receiptId,
            () => {
              this.assertAdmission(pins, freshInspection, signal);
            },
            { inspectedMainHead: inspectedMainHead!, admittedMainHead: freshInspection.mainHead },
          );
          admitted = true;
        },
        (mergeCommit) => records.recordRemoteAcknowledgement(pins, mergeCommit),
      );
      if (admitted && observed.state === 'accepted') return records.accept(pins, observed);
      if (admitted && observed.state === 'conflicted')
        return records.accept(pins, observed.observed);
      return this.deny(pins, inspectedMainHead); // Admitted operations remain uncertain.
    } catch {
      // deny never converts uncertainty/acceptance to a safe-to-repeat state.
      return this.deny(pins, inspectedMainHead);
    }
  }
  private deny(pins: MainPublicationPins, inspectedMainHead?: string) {
    const records = this.work.mainPublicationsForHost();
    const receipt = records.deny(pins, inspectedMainHead);
    if (receipt.state !== 'denied') return receipt;
    try {
      this.work.recordMainPublicationDenialForHost(pins, () => this.host.assertCurrent(pins));
    } catch {
      /* Host denial is expected; uncertain operations stay requested. */
    }
    return receipt;
  }
  private assertAdmission(
    pins: MainPublicationPins,
    ready: Extract<MainPublicationInspection, { state: 'ready' }>,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    this.host.assertCurrent(pins);
    this.work.mainPublicationsForHost().assertWorkCurrent(pins);
    const actor = { kind: 'conversation' as const, id: pins.authority.conversationId };
    const evidenceRef = `github-main:${createHash('sha256').update(ready.evidenceRef).digest('hex')}`;
    for (const control of this.work.controlInbox(pins.input.itemId, actor)) {
      if (control.scope !== 'publication' || control.stage !== 'released') continue;
      this.work.recordControlRevalidationForHost(
        {
          controlId: control.controlId,
          itemId: pins.input.itemId,
          mainCommit: ready.mainHead,
          evidenceRef,
        },
        () => true,
      );
    }
    // Denial-only: an already-admitted uncertain publication may still be in
    // flight, so this owner must not falsely mark a new hold as fully applied.
    this.work.assertControlAction(pins.input.itemId, 'publication', ready.mainHead);
  }
}
