import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { TelosWorkView } from '@mitzo/protocol';
import { TelosWorkError } from './telos-work-store.js';
import type {
  MainPublicationPins,
  MainPublicationReceipt,
  MainPublicationInspection,
} from './telos-main-publication-contract.js';
import {
  MainPublicationAccountSchema,
  MainPublicationResourceSchema,
  normalPrPublicationContract,
  RequestGithubMainPublicationSchema,
  githubCommit,
} from './telos-main-publication-contract.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function conflict(message: string): never {
  throw new TelosWorkError('conflict', message);
}
/** Receipt extension of the existing Telos DB; no scheduler, second DB or grant. */
export class TelosMainPublicationRecords {
  constructor(
    private readonly db: Database.Database,
    private readonly work: (id: string) => TelosWorkView,
    private readonly available: (id: string) => boolean,
  ) {}
  private key(pins: Pick<MainPublicationPins, 'authority'>) {
    return JSON.stringify([pins.authority.operatorId, pins.authority.conversationId]);
  }
  private row(pins: Pick<MainPublicationPins, 'input' | 'authority'>) {
    return this.db
      .prepare(
        'SELECT fingerprint,data FROM telos_work_main_publications WHERE actor_id=? AND request_id=?',
      )
      .get(this.key(pins), pins.input.requestId) as
      { fingerprint: string; data: string } | undefined;
  }
  private matching(
    pins: Pick<MainPublicationPins, 'input' | 'authority'> &
      Partial<Pick<MainPublicationPins, 'resource'>>,
  ): MainPublicationReceipt | undefined {
    const row = this.row(pins);
    if (!row) return undefined;
    const original = JSON.parse(row.data) as MainPublicationReceipt;
    if (
      original.pins.contract !== undefined &&
      original.pins.contract !== normalPrPublicationContract
    )
      conflict('Unsupported historical publication contract cannot be reinterpreted');
    if (!MainPublicationResourceSchema.safeParse(original.pins.resource).success)
      conflict(
        'Original publication remote identity unavailable; legacy custody cannot be guessed',
      );
    if (pins.resource && !isDeepStrictEqual(pins.resource, original.pins.resource))
      conflict('Publication remote resource identity changed; original receipt cannot be rebound');
    // Current assignments/runtime can change. Historical reconciliation is allowed
    // only for the original signed account/connection and exact original input.
    for (const key of [
      'operatorId',
      'conversationId',
      'connectionId',
      'capabilityId',
      'repository',
    ] as const)
      if (original.pins.authority[key] !== pins.authority[key])
        conflict('Publication authority changed; original receipt cannot be rebound');
    if (!isDeepStrictEqual(original.pins.authority.accountBinding, pins.authority.accountBinding))
      conflict('Publication account binding changed; original receipt cannot be rebound');
    const intent =
      !pins.resource &&
      pins.input.mainHead === undefined &&
      original.pins.contract !== normalPrPublicationContract
        ? {
            requestId: original.pins.input.requestId,
            itemId: original.pins.input.itemId,
            pullRequest: original.pins.input.pullRequest,
            sourceHead: original.pins.input.sourceHead,
            workRevision: original.pins.input.workRevision,
          }
        : original.pins.input;
    if (digest(intent) !== digest(pins.input))
      conflict('Publication request identity reused with different input');
    return original;
  }
  /** ACK arrival and independent observation can be ordered either way. Keep
   * both facts; projection must never rewrite a terminal observation receipt. */
  private project(receipt: MainPublicationReceipt): MainPublicationReceipt {
    const rows = this.db
      .prepare(
        'SELECT merge_commit FROM telos_work_main_publication_acknowledgements WHERE actor_id=? AND request_id=? ORDER BY merge_commit',
      )
      .all(this.key(receipt.pins), receipt.pins.input.requestId) as { merge_commit: string }[];
    const commits = [
      ...new Set([
        ...(receipt.remoteMergeCommit ? [receipt.remoteMergeCommit] : []),
        ...rows.map((row) => row.merge_commit),
      ]),
    ].sort();
    if (!commits.length) return receipt;
    const facts = {
      ...receipt,
      acknowledgedMergeCommits: commits,
      ...(commits.length === 1 ? { remoteMergeCommit: commits[0] } : {}),
    };
    if (commits.length > 1 || (receipt.mergeCommit && commits[0] !== receipt.mergeCommit))
      return { ...facts, state: 'conflicted', verification: 'conflicting_evidence' };
    if (receipt.state === 'accepted') return { ...facts, verification: 'acknowledged_squash' };
    return facts;
  }
  existingForHost(
    input: MainPublicationPins['input'],
    authority: MainPublicationPins['authority'],
  ) {
    const receipt = this.matching({ input, authority });
    return receipt ? this.project(receipt) : undefined;
  }
  assertWorkCurrent(pins: MainPublicationPins) {
    const { input, authority } = pins;
    MainPublicationAccountSchema.parse(authority.accountBinding);
    const work = this.work(input.itemId);
    const role = work.kind === 'work_item' ? 'worker' : 'lead';
    const assignment = work.assignments.find((a) => a.role === role);
    if (
      ![
        authority.operatorId,
        authority.conversationId,
        authority.runtimeId,
        authority.connectionId,
        authority.capabilityId,
        authority.repository,
      ].every((id) => typeof id === 'string' && id.trim()) ||
      work.revision !== input.workRevision ||
      !['coordinator', 'outcome', 'work_item'].includes(work.kind ?? '') ||
      !this.available(authority.conversationId) ||
      assignment?.conversation.conversationId !== authority.conversationId ||
      assignment.revision !== authority.assignmentRevision ||
      (work.attempts.at(-1)?.attemptId ?? null) !== authority.attemptId
    )
      throw new TelosWorkError(
        'unauthorized',
        'Current publication work and assignment authority required',
      );
  }
  prepare(pins: MainPublicationPins): MainPublicationReceipt {
    return this.db
      .transaction(() => {
        const previous = this.matching(pins);
        if (previous) return this.project(previous);
        if (pins.contract !== normalPrPublicationContract)
          conflict('New publication requires the current normal-PR permission contract');
        RequestGithubMainPublicationSchema.parse(pins.input);
        MainPublicationResourceSchema.parse(pins.resource);
        this.assertWorkCurrent(pins);
        const receipt: MainPublicationReceipt = { pins: structuredClone(pins), state: 'requested' };
        this.db
          .prepare(
            'INSERT INTO telos_work_main_publications(actor_id,request_id,item_id,fingerprint,data) VALUES(?,?,?,?,?)',
          )
          .run(
            this.key(pins),
            pins.input.requestId,
            pins.input.itemId,
            digest(pins),
            JSON.stringify(receipt),
          );
        return receipt;
      })
      .immediate();
  }
  /** Synchronous SQLite admission orders holds/work changes and the original
   * uncertain receipt before the adapter can issue its remote mutation. */
  admit(
    pins: MainPublicationPins,
    approvalReceiptId: string,
    assertCurrent: () => void,
    observations: { inspectedMainHead: string; admittedMainHead: string },
  ): void {
    this.db
      .transaction(() => {
        const receipt = this.matching(pins);
        if (pins.contract !== normalPrPublicationContract)
          conflict('Historical exact-main approval cannot admit a normal-PR effect');
        RequestGithubMainPublicationSchema.parse(pins.input);
        githubCommit.parse(observations.inspectedMainHead);
        githubCommit.parse(observations.admittedMainHead);
        if (receipt?.state !== 'requested' || digest(receipt.pins) !== digest(pins))
          conflict('Publication operation was already admitted or its owner changed');
        const admitted = this.db
          .prepare(
            `SELECT data FROM telos_work_main_publications
          WHERE json_extract(data,'$.state') IN ('uncertain','accepted')`,
          )
          .all() as { data: string }[];
        for (const row of admitted) {
          const resource = MainPublicationResourceSchema.safeParse(
            (JSON.parse(row.data) as MainPublicationReceipt).pins.resource,
          );
          if (!resource.success)
            conflict(
              'Unidentified legacy publication requires original identity evidence before new admission',
            );
          if (
            resource.data.repositoryId === pins.resource.repositoryId &&
            resource.data.pullRequestId === pins.resource.pullRequestId
          )
            conflict(
              'An original publication for this PR is already admitted; observe its receipt',
            );
        }
        this.assertWorkCurrent(pins);
        if (!approvalReceiptId.trim()) conflict('Exact operator approval receipt required');
        assertCurrent();
        this.write(pins, { ...receipt, state: 'uncertain', approvalReceiptId, ...observations });
      })
      .immediate();
  }
  hasUncertainForItems(itemIds: readonly string[]): boolean {
    return itemIds.some((id) => {
      const rows = this.db
        .prepare(
          "SELECT data FROM telos_work_main_publications WHERE item_id=? AND json_extract(data,'$.state') IN ('uncertain','accepted')",
        )
        .all(id) as { data: string }[];
      return rows.some((row) => {
        const receipt = JSON.parse(row.data) as MainPublicationReceipt;
        return receipt.state === 'uncertain' || this.project(receipt).state === 'conflicted';
      });
    });
  }

  deny(pins: MainPublicationPins, inspectedMainHead?: string): MainPublicationReceipt {
    return this.db
      .transaction(() => {
        const receipt = this.matching(pins);
        if (!receipt) return conflict('Publication receipt not found');
        if (receipt.state === 'requested') {
          if (inspectedMainHead) githubCommit.parse(inspectedMainHead);
          const denied = {
            ...receipt,
            state: 'denied' as const,
            ...(inspectedMainHead ? { inspectedMainHead } : {}),
          };
          this.write(pins, denied);
          return denied;
        }
        return this.project(receipt);
      })
      .immediate();
  }
  recordRemoteAcknowledgement(pins: MainPublicationPins, mergeCommit: string): void {
    githubCommit.parse(mergeCommit);
    this.db
      .transaction(() => {
        const receipt = this.matching(pins);
        if (
          !receipt ||
          !['uncertain', 'accepted'].includes(receipt.state) ||
          !receipt.approvalReceiptId ||
          pins.contract !== normalPrPublicationContract ||
          !isDeepStrictEqual(receipt.pins, pins)
        )
          conflict('Only this admitted normal-PR operation can retain its remote acknowledgement');
        this.db
          .prepare(
            `INSERT INTO telos_work_main_publication_acknowledgements(actor_id,request_id,merge_commit,approval_receipt_id)
           VALUES(?,?,?,?) ON CONFLICT(actor_id,request_id,merge_commit) DO NOTHING`,
          )
          .run(this.key(pins), pins.input.requestId, mergeCommit, receipt.approvalReceiptId);
      })
      .immediate();
  }
  accept(
    pins: MainPublicationPins,
    observed: Extract<MainPublicationInspection, { state: 'accepted' }>,
  ): MainPublicationReceipt {
    const { mergeCommit } = observed;
    githubCommit.parse(observed.baseHead);
    githubCommit.parse(observed.mainHead);
    return this.db
      .transaction(() => {
        const receipt = this.matching(pins);
        if (!receipt || !['uncertain', 'accepted'].includes(receipt.state))
          return conflict('Only an admitted publication can acquire a merge receipt');
        if (
          !/^[a-f0-9]{40}$/.test(mergeCommit) ||
          (receipt.mergeCommit && receipt.mergeCommit !== mergeCommit)
        )
          return conflict('Publication merge identity changed');
        if (
          pins.contract !== normalPrPublicationContract &&
          pins.input.mainHead !== observed.baseHead
        )
          conflict('Historical exact-main receipt must preserve its original approved base');
        if (receipt.state === 'accepted') return this.project(receipt);
        const accepted = {
          ...receipt,
          state: 'accepted' as const,
          mergeCommit,
          acceptedBaseHead: observed.baseHead,
          acceptedMainHead: observed.mainHead,
          verification: receipt.remoteMergeCommit
            ? ('acknowledged_squash' as const)
            : ('observed_merged' as const),
        };
        this.write(pins, accepted);
        return this.project(accepted);
      })
      .immediate();
  }
  private write(pins: MainPublicationPins, receipt: MainPublicationReceipt) {
    this.db
      .prepare('UPDATE telos_work_main_publications SET data=? WHERE actor_id=? AND request_id=?')
      .run(JSON.stringify(receipt), this.key(pins), pins.input.requestId);
  }
}
