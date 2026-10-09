import { knowledgeHostCommand } from './knowledge-host-command.js';
import { z } from 'zod';
import {
  GitHubCliHostPublisher,
  type GithubHostCommandRunner,
} from './connections/capabilities/github-publish-pr-transport.js';

export interface KnowledgeGithubConfiguration {
  repository: string;
  baseBranch: string;
  publisherLogin: string;
  trustedReviewer: string;
  acceptanceEnabled: boolean;
}
export interface KnowledgeReviewIdentity {
  draftId: string;
  url: string;
  head: string;
  repository: string;
  baseBranch: string;
  signal?: AbortSignal;
}
export interface KnowledgeReviewInspection {
  state: 'in-review' | 'accepted' | 'closed';
  head: string;
  canAccept: boolean;
  reason?: string;
  mergeCommit?: string;
  draft?: boolean;
}
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const pullRequest = z.object({
  html_url: z.string(),
  number: z.number().int().positive(),
  user: z.object({ login: z.string() }),
  draft: z.boolean(),
  state: z.enum(['open', 'closed']),
  merged: z.boolean(),
  merge_commit_sha: sha.nullable(),
  head: z.object({ ref: z.string(), sha, repo: z.object({ full_name: z.string() }) }),
  base: z.object({ ref: z.string(), repo: z.object({ full_name: z.string() }) }),
});
const report = z.object({
  user: z.object({ login: z.string() }).nullable(),
  body: z.string().nullable(),
  submitted_at: z.string().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  state: z.string().optional(),
  commit_id: z.string().optional(),
});
/** The default-branch Centaur gate's exact format, with trusted review/comment chronology. */
export function finalKnowledgeApproval(
  records: unknown[],
  head: string,
  reviewer: string,
): boolean {
  const reports = z
    .array(report)
    .parse(records)
    .filter(
      (r) =>
        r.user?.login.toLowerCase() === reviewer.toLowerCase() &&
        r.body?.includes('## Centaur Review'),
    );
  const chronology = reports.map((record) => {
    const times = [record.submitted_at, record.created_at, record.updated_at]
      .filter((value): value is string => value !== undefined && value !== null)
      .map((value) => Date.parse(value));
    return {
      record,
      time:
        !times.length || times.some((value) => !Number.isFinite(value)) ? NaN : Math.max(...times),
    };
  });
  // An edit is a new verdict. Unknown chronology and equal effective instants
  // cannot establish a final trusted decision and therefore block acceptance.
  if (chronology.some(({ time }) => !Number.isFinite(time))) return false;
  chronology.sort((a, b) => a.time - b.time);
  const final = chronology.at(-1);
  if (!final || chronology.at(-2)?.time === final.time) return false;
  const latest = final.record;
  const body = latest.body || '';
  const current =
    /^[a-f0-9]{40}$/.test(head) &&
    body.includes(`<!-- centaur:sha:${head} -->`) &&
    (latest.commit_id === undefined || latest.commit_id === head);
  return (
    current &&
    latest.state !== 'DISMISSED' &&
    new RegExp(
      `^<!-- centaur:sha:${head} -->\\s*## Centaur Review\\s*` +
        'LGTM — no issues found\\.\\s*### Convergence\\s*' +
        '\\*\\*Recommendation:\\*\\* `merge`[^\\n]*\\n',
    ).test(body) &&
    body.split('**Recommendation:**').length === 2 &&
    body.split('## Centaur Review').length === 2 &&
    body.split('<!-- centaur:sha:').length === 2 &&
    body.split('New blocking findings:').length === 2 &&
    body.split('Unresolved blocking findings:').length === 2 &&
    /^- New blocking findings: 0[ \t]*$/m.test(body) &&
    /^- Unresolved blocking findings: 0[ \t]*$/m.test(body)
  );
}
/** Host-only adapter. Saving a review, accepting a source and consumer publication stay distinct. */
export class KnowledgeGithubPublisher extends GitHubCliHostPublisher {
  private readonly command: GithubHostCommandRunner;
  constructor(
    readonly configuration: KnowledgeGithubConfiguration,
    runHost: GithubHostCommandRunner = knowledgeHostCommand,
  ) {
    const command: GithubHostCommandRunner = (program, args, signal) =>
      runHost(program, args, AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
    super(command);
    this.command = command;
    if (
      !/^[a-z0-9-]+\/[a-z0-9_.-]+$/.test(configuration.repository) ||
      !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(configuration.baseBranch) ||
      configuration.baseBranch.includes('..') ||
      ![configuration.publisherLogin, configuration.trustedReviewer].every((login) =>
        /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?(?:\[bot\])?$/i.test(login),
      )
    )
      throw new Error('Knowledge publisher configuration is invalid');
  }
  private checked(input: KnowledgeReviewIdentity) {
    if (
      input.repository !== this.configuration.repository ||
      input.baseBranch !== this.configuration.baseBranch ||
      !/^[a-f0-9-]{36}$/.test(input.draftId) ||
      !/^[a-f0-9]{40}$/.test(input.head)
    )
      throw new Error('Knowledge review identity is invalid');
    const prefix = `https://github.com/${input.repository}/pull/`;
    const number = input.url.startsWith(prefix) ? input.url.slice(prefix.length) : '';
    if (!/^[1-9][0-9]*$/.test(number)) throw new Error('Knowledge review identity is invalid');
    return number;
  }
  private async readExact(input: KnowledgeReviewIdentity, number: string, signal: AbortSignal) {
    const response = await this.command(
      'gh',
      ['api', '--method', 'GET', `repos/${input.repository}/pulls/${number}`],
      signal,
    );
    const pr = pullRequest.parse(JSON.parse(response.stdout));
    if (
      String(pr.number) !== number ||
      pr.html_url !== input.url ||
      pr.head.ref !== `knowledge/${input.draftId}` ||
      pr.head.repo.full_name.toLowerCase() !== input.repository ||
      pr.base.repo.full_name.toLowerCase() !== input.repository ||
      pr.base.ref !== input.baseBranch ||
      pr.user.login.toLowerCase() !== this.configuration.publisherLogin.toLowerCase()
    )
      throw new Error('Knowledge review scope changed');
    return pr;
  }
  private async reports(input: KnowledgeReviewIdentity, number: string, signal: AbortSignal) {
    const records: unknown[] = [];
    for (const endpoint of [`pulls/${number}/reviews`, `issues/${number}/comments`]) {
      const result = await this.command(
        'gh',
        [
          'api',
          '--method',
          'GET',
          `repos/${input.repository}/${endpoint}`,
          '--paginate',
          '--slurp',
        ],
        signal,
      );
      records.push(...z.array(z.array(z.unknown())).parse(JSON.parse(result.stdout)).flat());
    }
    return records;
  }
  private async checks(input: KnowledgeReviewIdentity, number: string, signal: AbortSignal) {
    try {
      const response = await this.command(
        'gh',
        [
          'pr',
          'checks',
          number,
          '--repo',
          input.repository,
          '--required',
          '--json',
          'name,bucket,state',
        ],
        signal,
      );
      const checks = z
        .array(z.object({ name: z.string(), bucket: z.string(), state: z.string() }))
        .parse(JSON.parse(response.stdout));
      return checks.length > 0 && checks.every((check) => check.bucket === 'pass');
    } catch {
      return false;
    }
  }
  async inspect(input: KnowledgeReviewIdentity): Promise<KnowledgeReviewInspection> {
    const number = this.checked(input);
    const signal = input.signal ?? AbortSignal.timeout(120_000);
    if (
      (await this.identity(signal)).toLowerCase() !==
      this.configuration.publisherLogin.toLowerCase()
    )
      throw new Error('Knowledge publishing account changed');
    const pr = await this.readExact(input, number, signal);
    if (pr.head.sha !== input.head)
      throw new Error('Knowledge review head changed; reload before accepting');
    if (pr.merged) {
      if (pr.state !== 'closed' || !pr.merge_commit_sha)
        throw new Error('Knowledge acceptance is unconfirmed');
      return {
        state: 'accepted',
        head: pr.head.sha,
        canAccept: false,
        mergeCommit: pr.merge_commit_sha,
      };
    }
    if (pr.state === 'closed') return { state: 'closed', head: pr.head.sha, canAccept: false };
    const approved = finalKnowledgeApproval(
      await this.reports(input, number, signal),
      input.head,
      this.configuration.trustedReviewer,
    );
    const checks = approved && (await this.checks(input, number, signal));
    const refreshed = await this.readExact(input, number, signal);
    if (refreshed.head.sha !== input.head || refreshed.state !== 'open')
      throw new Error('Knowledge review changed during inspection');
    const canAccept =
      this.configuration.acceptanceEnabled && !refreshed.draft && approved && checks;
    return {
      state: 'in-review',
      head: input.head,
      draft: refreshed.draft,
      canAccept,
      reason: canAccept
        ? undefined
        : !this.configuration.acceptanceEnabled
          ? 'Acceptance is disabled by host configuration'
          : refreshed.draft
            ? 'Send the saved change for review before accepting'
            : !approved
              ? 'Final current-head Centaur LGTM is required'
              : 'All required checks must pass; missing required checks block acceptance',
    };
  }
  /** Explicit operator transition: request review without claiming acceptance. */
  async sendForReview(
    input: KnowledgeReviewIdentity,
  ): Promise<KnowledgeReviewInspection & { state: 'in-review'; draft: false }> {
    const number = this.checked(input);
    const signal = input.signal ?? AbortSignal.timeout(120_000);
    signal.throwIfAborted();
    if (
      (await this.identity(signal)).toLowerCase() !==
      this.configuration.publisherLogin.toLowerCase()
    )
      throw new Error('Knowledge publishing account changed');
    signal.throwIfAborted();
    const assertOpenHead = (pr: z.infer<typeof pullRequest>) => {
      if (pr.state !== 'open' || pr.merged || pr.head.sha !== input.head)
        throw new Error('Knowledge review head or state changed; reload before requesting review');
    };
    assertOpenHead(await this.readExact(input, number, signal));
    signal.throwIfAborted();
    // Re-read immediately before the mutation; an earlier observed head is insufficient.
    const current = await this.readExact(input, number, signal);
    signal.throwIfAborted();
    assertOpenHead(current);
    if (current.draft)
      await this.command('gh', ['pr', 'ready', number, '--repo', input.repository], signal);
    signal.throwIfAborted();
    const ready = await this.readExact(input, number, signal);
    signal.throwIfAborted();
    assertOpenHead(ready);
    if (ready.draft) throw new Error('Knowledge review readiness could not be confirmed');
    return { state: 'in-review', head: input.head, draft: false, canAccept: false };
  }
  async accept(input: KnowledgeReviewIdentity): Promise<KnowledgeReviewInspection> {
    this.checked(input);
    if (!this.configuration.acceptanceEnabled) throw new Error('Knowledge acceptance is disabled');
    const signal = input.signal ?? AbortSignal.timeout(180_000);
    const scoped = { ...input, signal };
    const status = await this.inspect(scoped);
    if (status.state === 'accepted') return status;
    if (status.draft !== false || !status.canAccept)
      throw new Error(
        status.draft !== false
          ? 'Send the saved change for review before accepting'
          : (status.reason ?? 'Knowledge review is not ready for acceptance'),
      );
    const number = this.checked(input);
    const ready = await this.inspect(scoped);
    if (ready.draft !== false || !ready.canAccept)
      throw new Error(
        ready.draft !== false
          ? 'Send the saved change for review before accepting'
          : (ready.reason ?? 'Knowledge review changed before acceptance'),
      );
    await this.command(
      'gh',
      [
        'pr',
        'merge',
        number,
        '--repo',
        input.repository,
        '--squash',
        '--match-head-commit',
        input.head,
      ],
      signal,
    );
    const merged = await this.inspect(scoped);
    if (merged.state !== 'accepted') throw new Error('Knowledge acceptance is unconfirmed');
    return merged;
  }
}
