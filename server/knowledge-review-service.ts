import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AcceptedKnowledgeSource, knowledgeGit } from './knowledge-library-source.js';
import {
  KnowledgeDraftConflict,
  KnowledgeDraftStore,
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
};
/** Operator saves use a host-owned source and publisher, independent of provider/chat authority. */
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
        'This draft is saving its review. Try again when it finishes.',
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
  private async projection(draft: KnowledgeDraft, accepted: string, branch: string) {
    if (draft.publication?.version === draft.version) return draft.publication.head;
    const parent = draft.publication?.head ?? accepted;
    const temporary = await mkdtemp(join(tmpdir(), 'mitzo-knowledge-index-'));
    const index = join(temporary, 'index');
    try {
      await knowledgeGit(this.source.directory, ['read-tree', accepted], undefined, index);
      for (const document of draft.documents) {
        const sha = (
          await knowledgeGit(
            this.source.directory,
            ['hash-object', '-w', '--stdin'],
            document.content,
          )
        ).trim();
        await knowledgeGit(
          this.source.directory,
          ['update-index', '--add', '--cacheinfo', `100644,${sha},${document.path}`],
          undefined,
          index,
        );
      }
      const tree = (
        await knowledgeGit(this.source.directory, ['write-tree'], undefined, index)
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
        )
      ).trim();
      await knowledgeGit(this.source.directory, ['update-ref', `refs/heads/${branch}`, head]);
      // Persist before the first network mutation: a retry recovers this exact commit.
      this.store.prepared(draft.id, draft.version, head);
      return head;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  async submit(id: string, version: number, authorizationSignal?: AbortSignal) {
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
        throw new KnowledgeDraftConflict('Draft changed in another window. Reload before saving.');
      if (draft.state === 'accepted' || draft.state === 'closed')
        throw new KnowledgeDraftConflict('This change is finished. Start a new draft.');
      if (
        (await this.publisher.identity(signal)).toLowerCase() !==
        this.config.publisherLogin.toLowerCase()
      )
        throw new Error('Publishing account changed');
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
          this.store.status(id, existing.merged ? 'accepted' : 'closed');
          throw new KnowledgeDraftConflict('This change is finished. Start a new draft.');
        }
      }
      const accepted = await this.source.revision();
      for (const document of draft.documents) {
        const original = await this.source.read(document.path, draft.baseRevision);
        if (document.base !== original.content)
          throw new KnowledgeDraftConflict('Draft base differs from its accepted revision');
        const latest = await this.source.read(document.path, accepted);
        if (latest.content !== document.base)
          throw new KnowledgeDraftConflict(
            `${document.path} changed since this draft started. Compare the accepted document and resolve before saving its review.`,
          );
      }
      if (!draft.publication && draft.documents.every((d) => d.content === d.base))
        throw new KnowledgeDraftConflict('No changes to review');
      const remote = await this.publisher.readBranch(common);
      signal.throwIfAborted();
      if (remote && remote !== draft.publication?.head && remote !== draft.review?.head)
        throw new KnowledgeDraftConflict(
          'This review changed elsewhere. Reload its review before continuing.',
        );
      const head = await this.projection(draft, accepted, branch);
      if (remote !== head) {
        const temporary = await mkdtemp(join(tmpdir(), 'mitzo-knowledge-bundle-'));
        try {
          const path = join(temporary, 'change.bundle');
          await knowledgeGit(this.source.directory, [
            'bundle',
            'create',
            path,
            `refs/heads/${branch}`,
            '--not',
            accepted,
          ]);
          if ((await stat(path)).size > 16 * 1024 * 1024)
            throw new Error('Change exceeds review export limit');
          const reconstructed = await this.publisher.reconstruct({
            ...common,
            sourceOid: head,
            bundle: await readFile(path),
          });
          cleanup = reconstructed.cleanupDirectory ?? reconstructed.directory;
          signal.throwIfAborted();
          await this.publisher.push({ ...common, directory: reconstructed.directory });
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      }
      const input = {
        ...common,
        title: draft.title,
        body: `Knowledge update from Mitzo.\n\n${draft.documents.map((d) => '- ' + d.path).join('\n')}\n\nChange: ${draft.id}. Saving this draft does not accept or publish it.`,
        draft: true,
      };
      signal.throwIfAborted();
      const result = this.scope(
        existing
          ? await this.publisher.update({ ...input, pullRequest: existing })
          : await this.publisher.create(input),
        branch,
      );
      if ((await this.publisher.readBranch(common)) !== head)
        throw new Error('Review head verification failed');
      const verified = await this.publisher.read({ ...common, externalResultId: result.url });
      if (!verified || verified.state !== 'open' || !verified.draft)
        throw new Error('Review verification failed');
      this.scope(verified, branch);
      signal.throwIfAborted();
      return this.store.receipt(id, version, { url: verified.url, head });
    } catch (error) {
      if (error instanceof KnowledgeDraftConflict) throw error;
      this.store.status(
        id,
        'draft',
        'Draft saved. Its review could not be confirmed. Retry Save to recover the same change.',
      );
      throw new Error(
        'Draft saved. Its review could not be confirmed. Retry Save to recover the same change.',
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
