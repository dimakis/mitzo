import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AcceptedKnowledgeSource, knowledgeGit } from './knowledge-library-source.js';
import {
  KnowledgeDraftConflict,
  KnowledgeDraftStore,
  KNOWLEDGE_RECOVERY_BUNDLE_LIMIT,
  type KnowledgeDraft,
} from './knowledge-draft-store.js';
import type {
  KnowledgeReviewIdentity,
  KnowledgeReviewInspection,
} from './knowledge-github-publisher.js';
import type {
  GithubHostPublisher,
  GithubPullRequest,
} from './connections/capabilities/github-publish-pr.js';

export interface KnowledgeReviewConfiguration {
  repository: string;
  baseBranch: string;
  publisherLogin: string;
}
type Publisher = GithubHostPublisher & {
  identity(signal: AbortSignal): Promise<string>;
  inspect?(input: KnowledgeReviewIdentity): Promise<KnowledgeReviewInspection>;
  sendForReview?(
    input: KnowledgeReviewIdentity & { beforeReady?: () => void },
  ): Promise<KnowledgeReviewInspection & { state: 'in-review'; draft: false }>;
};
/** Explicit review sends use a host-owned source and publisher, independent of provider/chat authority. */
export class KnowledgeReviewService {
  private readonly busy = new Set<string>();
  constructor(
    readonly source: AcceptedKnowledgeSource,
    readonly store: KnowledgeDraftStore,
    private readonly publisher: Publisher,
    readonly config: KnowledgeReviewConfiguration,
  ) {}
  assertIdle(id: string) {
    this.store.assertIdle(id);
    if (this.busy.has(id))
      throw new KnowledgeDraftConflict(
        'This draft is sending its review. Try again when it finishes.',
      );
  }
  private scope(review: GithubPullRequest, branch: string) {
    if (
      review.repository !== this.config.repository ||
      review.sourceBranch !== branch ||
      review.baseBranch !== this.config.baseBranch ||
      !/^[1-9][0-9]*$/.test(review.id) ||
      review.url !== `https://github.com/${this.config.repository}/pull/${review.id}`
    )
      throw new Error('Review identity differs from this change');
    return review;
  }
  private async projection(
    draft: KnowledgeDraft,
    accepted: string,
    branch: string,
    signal: AbortSignal,
    lease: string,
    rebuildUnpublished: boolean,
  ) {
    let parent = draft.publication?.head ?? accepted;
    if (draft.publication) {
      const recovery = this.store.recoveryBundle(draft.id, parent);
      if (recovery) {
        const temporary = await mkdtemp(join(tmpdir(), 'mitzo-knowledge-recovery-'));
        try {
          const path = join(temporary, 'change.bundle');
          await writeFile(path, recovery, { mode: 0o600 });
          const heads = (
            await knowledgeGit(
              this.source.directory,
              ['bundle', 'list-heads', path],
              undefined,
              undefined,
              signal,
            )
          ).trim();
          if (heads !== `${parent} refs/heads/${branch}`)
            throw new Error('Knowledge recovery bundle differs from its saved head');
          this.store.assertLease(draft.id, lease);
          await knowledgeGit(
            this.source.directory,
            ['bundle', 'unbundle', path],
            undefined,
            undefined,
            signal,
          );
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      } else {
        try {
          await knowledgeGit(
            this.source.directory,
            ['cat-file', '-e', `${parent}^{commit}`],
            undefined,
            undefined,
            signal,
          );
        } catch (error) {
          signal.throwIfAborted();
          // Legacy backups contain no bundle. Only a confirmed unpublished change
          // can receive a new identity; a remote/review head must stay exact.
          if (!rebuildUnpublished) throw error;
          parent = accepted;
        }
      }
      if (parent === draft.publication.head && draft.publication.version === draft.version) {
        await this.prepare(draft, accepted, branch, parent, signal, lease);
        return parent;
      }
    }
    const temporary = await mkdtemp(join(tmpdir(), 'mitzo-knowledge-index-'));
    const index = join(temporary, 'index');
    try {
      await knowledgeGit(this.source.directory, ['read-tree', accepted], undefined, index, signal);
      for (const document of draft.documents) {
        if (document.sourcePath)
          await knowledgeGit(
            this.source.directory,
            ['update-index', '--force-remove', '--', document.sourcePath],
            undefined,
            index,
            signal,
          );
        const sha = (
          await knowledgeGit(
            this.source.directory,
            ['hash-object', '-w', '--stdin'],
            document.content,
            undefined,
            signal,
          )
        ).trim();
        await knowledgeGit(
          this.source.directory,
          ['update-index', '--add', '--cacheinfo', `100644,${sha},${document.path}`],
          undefined,
          index,
          signal,
        );
      }
      for (const directory of draft.directories ?? []) {
        // Only leaf empty folders need markers; documents and child folders already
        // preserve their ancestors in the Git tree.
        if (
          draft.documents.some((d) => d.path.startsWith(directory + '/')) ||
          draft.directories?.some((d) => d !== directory && d.startsWith(directory + '/'))
        )
          continue;
        const sha = (
          await knowledgeGit(
            this.source.directory,
            ['hash-object', '-w', '--stdin'],
            '',
            undefined,
            signal,
          )
        ).trim();
        await knowledgeGit(
          this.source.directory,
          ['update-index', '--add', '--cacheinfo', `100644,${sha},${directory}/.gitkeep`],
          undefined,
          index,
          signal,
        );
      }
      const tree = (
        await knowledgeGit(this.source.directory, ['write-tree'], undefined, index, signal)
      ).trim();
      const parents = parent === accepted ? ['-p', parent] : ['-p', parent, '-p', accepted];
      const head = (
        await knowledgeGit(
          this.source.directory,
          [
            '-c',
            'user.name=Mitzo Knowledge',
            '-c',
            'user.email=knowledge@mitzo.local',
            '-c',
            'commit.gpgsign=false',
            'commit-tree',
            tree,
            ...parents,
          ],
          draft.title + '\n',
          undefined,
          signal,
        )
      ).trim();
      await this.prepare(draft, accepted, branch, head, signal, lease);
      return head;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  private async prepare(
    draft: KnowledgeDraft,
    accepted: string,
    branch: string,
    head: string,
    signal: AbortSignal,
    lease: string,
  ) {
    this.store.assertLease(draft.id, lease);
    await knowledgeGit(
      this.source.directory,
      ['update-ref', `refs/heads/${branch}`, head],
      undefined,
      undefined,
      signal,
    );
    const temporary = await mkdtemp(join(tmpdir(), 'mitzo-knowledge-prepared-'));
    try {
      const path = join(temporary, 'change.bundle');
      await knowledgeGit(
        this.source.directory,
        ['bundle', 'create', path, `refs/heads/${branch}`, '--not', accepted],
        undefined,
        undefined,
        signal,
      );
      if ((await stat(path)).size > KNOWLEDGE_RECOVERY_BUNDLE_LIMIT)
        throw new Error('Change exceeds review export limit');
      // The commit and its recoverable objects enter the same SQLite transaction,
      // before any push. Core database backups therefore preserve both identities.
      this.store.prepared(draft.id, draft.version, head, lease, await readFile(path));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  /** Preserve the prepared-head recovery operation for host callers; Save never invokes it. */
  submit(id: string, version: number, authorizationSignal?: AbortSignal) {
    return this.submitBatch(id, version, authorizationSignal, false);
  }
  sendForReview(id: string, version: number, authorizationSignal?: AbortSignal) {
    if (!this.publisher.sendForReview) throw new Error('Review publishing is not configured');
    return this.submitBatch(id, version, authorizationSignal, true);
  }
  private async ready(draft: KnowledgeDraft, lease: string, signal: AbortSignal) {
    const review = draft.review;
    if (!review || review.version !== draft.version || !this.publisher.sendForReview)
      throw new KnowledgeDraftConflict('The current saved review could not be confirmed');
    const assertCurrent = () => {
      signal.throwIfAborted();
      this.store.assertLease(draft.id, lease);
      const current = this.store.get(draft.id);
      if (
        current.version !== draft.version ||
        current.review?.version !== draft.version ||
        current.review.head !== review.head ||
        current.state === 'accepted' ||
        current.state === 'closed'
      )
        throw new KnowledgeDraftConflict('Draft changed while sending its review');
    };
    assertCurrent();
    const sent = await this.publisher.sendForReview({
      draftId: draft.id,
      url: review.url,
      head: review.head,
      repository: this.config.repository,
      baseBranch: this.config.baseBranch,
      signal,
      beforeReady: assertCurrent,
    });
    assertCurrent();
    if (sent.head !== review.head || sent.draft !== false || sent.state !== 'in-review')
      throw new KnowledgeDraftConflict('Review submission could not be confirmed');
    return this.store.receipt(draft.id, draft.version, { ...review, ready: true }, lease);
  }
  private async submitBatch(
    id: string,
    version: number,
    authorizationSignal: AbortSignal | undefined,
    forReview: boolean,
  ) {
    this.assertIdle(id);
    const lease = this.store.acquire(id);
    this.busy.add(id);
    let cleanup: string | undefined;
    const signal = AbortSignal.any([
      AbortSignal.timeout(120_000),
      ...(authorizationSignal ? [authorizationSignal] : []),
    ]);
    try {
      const draft = this.store.get(id);
      if (draft.version !== version)
        throw new KnowledgeDraftConflict(
          'Draft changed in another window. Reload before sending its review.',
        );
      if (draft.state === 'accepted' || draft.state === 'closed')
        throw new KnowledgeDraftConflict('This change is finished. Start a new draft.');
      if (
        (await this.publisher.identity(signal)).toLowerCase() !==
        this.config.publisherLogin.toLowerCase()
      )
        throw new Error('Publishing account changed');
      if (forReview && draft.review?.version === version) {
        if (
          draft.publication &&
          (draft.publication.version !== version || draft.publication.head !== draft.review.head)
        )
          throw new KnowledgeDraftConflict('Saved publication differs from its confirmed review');
        return await this.ready(draft, lease, signal);
      }
      const branch = `knowledge/${draft.id}`;
      const common = {
        repository: this.config.repository,
        sourceBranch: branch,
        baseBranch: this.config.baseBranch,
        operationId: draft.id,
        signal,
      };
      const policy = await this.publisher.policy(common);
      if (policy.defaultBranch !== this.config.baseBranch || policy.sourceBranchProtected)
        throw new Error('Publishing policy changed');
      const existing = await this.publisher.read({
        ...common,
        externalResultId: draft.review?.url,
      });
      if (existing) {
        this.scope(existing, branch);
        if (existing.state === 'closed') {
          if (draft.review && draft.version !== draft.review.version) {
            this.store.status(
              id,
              'draft',
              'Previous review finished. Start a new change with your remaining edits.',
              lease,
              version,
            );
            throw new KnowledgeDraftConflict(
              'Previous review finished. Start a new change with your remaining edits.',
            );
          }
          if (!draft.review || existing.url !== draft.review.url)
            throw new Error('Finished review has no confirmed saved receipt');
          if (existing.merged) {
            if (!this.publisher.inspect)
              throw new Error('Exact merged review inspection unavailable');
            const inspected = await this.publisher.inspect({
              draftId: draft.id,
              url: draft.review.url,
              head: draft.review.head,
              repository: this.config.repository,
              baseBranch: this.config.baseBranch,
              signal,
            });
            if (inspected.state !== 'accepted' || inspected.head !== draft.review.head)
              throw new Error('Merged review differs from the saved review head');
          }
          signal.throwIfAborted();
          this.store.status(id, existing.merged ? 'accepted' : 'closed', undefined, lease, version);
          throw new KnowledgeDraftConflict('This change is finished. Start a new draft.');
        }
      }
      const accepted = await this.source.revision(signal);
      try {
        await this.source.validateStructure(
          draft.baseRevision,
          draft.documents,
          draft.directories,
          signal,
        );
        await this.source.validateStructure(accepted, draft.documents, draft.directories, signal);
      } catch (error) {
        signal.throwIfAborted();
        throw new KnowledgeDraftConflict(
          error instanceof Error ? error.message : 'Knowledge structure changed',
        );
      }
      for (const document of draft.documents) {
        const sourcePath = document.sourcePath ?? document.path;
        const original = await this.source.read(sourcePath, draft.baseRevision, signal);
        if (document.base !== original.content)
          throw new KnowledgeDraftConflict('Draft base differs from its accepted revision');
        const latest = await this.source.read(sourcePath, accepted, signal);
        if (latest.content !== document.base)
          throw new KnowledgeDraftConflict(
            `${document.path} changed since this draft started. Compare the accepted document and resolve before sending its review.`,
          );
      }
      if (
        !draft.publication &&
        !draft.directories?.length &&
        draft.documents.every((d) => !d.sourcePath && d.content === d.base)
      )
        throw new KnowledgeDraftConflict('No changes to review');
      const remote = await this.publisher.readBranch(common);
      signal.throwIfAborted();
      if (remote && remote !== draft.publication?.head && remote !== draft.review?.head)
        throw new KnowledgeDraftConflict(
          'This review changed elsewhere. Reload its review before continuing.',
        );
      const input = {
        ...common,
        title: draft.title,
        body: `Knowledge update from Mitzo.\n\n${[...draft.documents.map((d) => '- ' + (d.sourcePath ? d.sourcePath + ' → ' : '') + d.path), ...(draft.directories ?? []).map((d) => '- Folder: ' + d)].join('\n')}\n\nChange: ${draft.id}. Saving this draft does not accept or publish it.`,
        draft: true,
      };
      let confirmedDraftReview: GithubPullRequest | undefined;
      const head = await this.projection(
        draft,
        accepted,
        branch,
        signal,
        lease,
        !remote && !existing && !draft.review,
      );
      if (forReview && existing && remote === head && draft.publication?.version === version) {
        // A lost create/update acknowledgement must not redraft or rewrite the
        // same published batch. Reinspect its identity and head, then request ready.
        const confirmed = await this.publisher.read({ ...common, externalResultId: existing.url });
        if (
          !confirmed ||
          confirmed.state !== 'open' ||
          confirmed.url !== existing.url ||
          (await this.publisher.readBranch(common)) !== head
        )
          throw new KnowledgeDraftConflict('The prepared review changed. Reload before sending.');
        this.scope(confirmed, branch);
        signal.throwIfAborted();
        this.store.assertLease(id, lease);
        const recovered = this.store.receipt(id, version, { url: confirmed.url, head }, lease);
        return await this.ready(recovered, lease, signal);
      }
      if (remote !== head) {
        const temporary = await mkdtemp(join(tmpdir(), 'mitzo-knowledge-bundle-'));
        try {
          const path = join(temporary, 'change.bundle');
          await knowledgeGit(
            this.source.directory,
            ['bundle', 'create', path, `refs/heads/${branch}`, '--not', accepted],
            undefined,
            undefined,
            signal,
          );
          if ((await stat(path)).size > KNOWLEDGE_RECOVERY_BUNDLE_LIMIT)
            throw new Error('Change exceeds review export limit');
          const reconstructed = await this.publisher.reconstruct({
            ...common,
            sourceOid: head,
            bundle: await readFile(path),
          });
          cleanup = reconstructed.cleanupDirectory ?? reconstructed.directory;
          signal.throwIfAborted();
          this.store.assertLease(id, lease);
          if (existing && !existing.draft) {
            if (!remote || !this.publisher.inspect)
              throw new Error('Exact ready review inspection unavailable');
            // Keep the old head in place until Send has returned the PR to draft.
            // Otherwise synchronize can start another review of unpublished edits.
            const redrafted = this.scope(
              await this.publisher.update({ ...input, pullRequest: existing }),
              branch,
            );
            signal.throwIfAborted();
            this.store.assertLease(id, lease);
            if (redrafted.url !== existing.url || redrafted.state !== 'open' || !redrafted.draft)
              throw new Error('Review draft conversion could not be confirmed');
            const inspected = await this.publisher.inspect({
              draftId: draft.id,
              url: existing.url,
              head: remote,
              repository: this.config.repository,
              baseBranch: this.config.baseBranch,
              signal,
            });
            if (inspected.state !== 'in-review' || !inspected.draft || inspected.head !== remote)
              throw new Error('Review draft conversion differs from its saved head');
            if ((await this.publisher.readBranch(common)) !== remote)
              throw new Error('Review head changed during draft conversion');
            signal.throwIfAborted();
            this.store.assertLease(id, lease);
            confirmedDraftReview = redrafted;
          }
          await this.publisher.push({ ...common, directory: reconstructed.directory });
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      }
      signal.throwIfAborted();
      this.store.assertLease(id, lease);
      const result = this.scope(
        confirmedDraftReview ??
          (existing
            ? await this.publisher.update({ ...input, pullRequest: existing })
            : await this.publisher.create(input)),
        branch,
      );
      if ((await this.publisher.readBranch(common)) !== head)
        throw new Error('Review head verification failed');
      const verified = await this.publisher.read({ ...common, externalResultId: result.url });
      if (!verified || verified.state !== 'open' || !verified.draft)
        throw new Error('Review verification failed');
      this.scope(verified, branch);
      signal.throwIfAborted();
      const published = this.store.receipt(id, version, { url: verified.url, head }, lease);
      return forReview ? await this.ready(published, lease, signal) : published;
    } catch (error) {
      if (error instanceof KnowledgeDraftConflict) throw error;
      try {
        this.store.status(
          id,
          'draft',
          'Draft saved. Its review could not be confirmed. Retry Send for review to recover the same change.',
          lease,
          version,
        );
      } catch {
        /* An expired owner cannot overwrite a newer save or acceptance. */
      }
      throw new Error(
        'Draft saved. Its review could not be confirmed. Retry Send for review to recover the same change.',
        { cause: error },
      );
    } finally {
      if (cleanup)
        await this.publisher.cleanup(cleanup).catch(() => {
          /* The owned transport retains its cleanup fence. */
        });
      this.busy.delete(id);
      this.store.release(id, lease);
    }
  }
}
