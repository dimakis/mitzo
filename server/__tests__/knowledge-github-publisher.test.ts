import { describe, expect, it, vi } from 'vitest';
import { KnowledgeGithubPublisher } from '../knowledge-github-publisher.js';
const head = 'a'.repeat(40);
const id = 'b20c4e28-9010-441f-85a8-734ad26c7d26';
const input = {
  draftId: id,
  url: 'https://github.com/owner/knowledge/pull/7',
  head,
  repository: 'owner/knowledge',
  baseBranch: 'main',
};
const approved = `<!-- centaur:sha:${head} -->\n## Centaur Review\nLGTM — no issues found.\n\n### Convergence\n**Recommendation:** \`merge\`\n- New blocking findings: 0\n- Unresolved blocking findings: 0\n`;
function fixture(
  options: {
    reports?: unknown[];
    comments?: unknown[];
    changedHead?: boolean;
    noChecks?: boolean;
    identity?: string;
    mergeFails?: boolean;
    acceptanceEnabled?: boolean;
    alreadyReady?: boolean;
    badScope?: boolean;
    closed?: boolean;
    changedAfterReady?: boolean;
    readyFails?: boolean;
    onRead?: (count: number) => void;
  } = {},
) {
  let merged = false;
  let ready = options.alreadyReady ?? false;
  let reads = 0;
  let metadataReads = 0;
  const run = vi.fn(async (_command: string, args: readonly string[]) => {
    let data: unknown;
    if (args[0] === 'api' && args.at(-1) === 'user')
      data = { login: options.identity ?? 'publisher' };
    else if (args.includes('pr') || args[0] === 'pr') {
      if (args[1] === 'checks')
        data = options.noChecks ? [] : [{ name: 'CI', bucket: 'pass', state: 'SUCCESS' }];
      else if (args[1] === 'ready') {
        ready = !options.readyFails;
        data = '';
      } else if (args[1] === 'merge') {
        merged = !options.mergeFails;
        data = '';
      }
    } else if (args.some((a) => a.endsWith('/reviews')))
      data = [
        options.reports ?? [
          {
            user: { login: 'owner' },
            body: approved,
            commit_id: head,
            state: 'COMMENTED',
            submitted_at: '2026-10-01T12:00:00Z',
          },
        ],
      ];
    else if (args.some((a) => a.endsWith('/comments'))) data = [options.comments ?? []];
    else {
      metadataReads++;
      options.onRead?.(metadataReads);
      data = {
        html_url: input.url,
        number: 7,
        user: { login: 'publisher' },
        draft: !ready,
        state: merged || options.closed ? 'closed' : 'open',
        merged,
        merge_commit_sha: merged ? 'c'.repeat(40) : null,
        head: {
          ref: `knowledge/${id}`,
          sha:
            (options.changedHead && reads++ > 0) || (options.changedAfterReady && ready)
              ? 'b'.repeat(40)
              : head,
          repo: { full_name: options.badScope ? 'attacker/knowledge' : input.repository },
        },
        base: { ref: 'main', repo: { full_name: input.repository } },
      };
    }
    return { stdout: typeof data === 'string' ? data : JSON.stringify(data), stderr: '' };
  });
  const publisher = new KnowledgeGithubPublisher(
    {
      repository: input.repository,
      baseBranch: 'main',
      publisherLogin: 'publisher',
      trustedReviewer: 'owner',
      acceptanceEnabled: options.acceptanceEnabled ?? true,
    },
    run,
  );
  return { publisher, run };
}
describe('host Knowledge acceptance gate', () => {
  it('merges only final current-head approval and required passing checks, verifies receipt', async () => {
    const { publisher, run } = fixture();
    const result = await publisher.accept(input);
    expect(result).toMatchObject({ state: 'accepted', head, mergeCommit: 'c'.repeat(40) });
    const commands = run.mock.calls.map((c) => c[1]);
    expect(commands).toContainEqual(['pr', 'ready', '7', '--repo', input.repository]);
    expect(commands).toContainEqual([
      'pr',
      'merge',
      '7',
      '--repo',
      input.repository,
      '--squash',
      '--match-head-commit',
      head,
    ]);
    expect(commands.flat()).not.toContain('--admin');
  });
  it.each([
    { reports: [] },
    {
      reports: [
        { user: { login: 'attacker' }, body: approved, created_at: '2026-10-01T12:00:00Z' },
      ],
    },
    {
      reports: [
        {
          user: { login: 'owner' },
          body: approved,
          state: 'DISMISSED',
          submitted_at: '2026-10-01T12:00:00Z',
        },
      ],
    },
    {
      reports: [
        {
          user: { login: 'owner' },
          body: approved.replace(head, 'b'.repeat(40)),
          submitted_at: '2026-10-01T12:00:00Z',
        },
      ],
    },
    {
      reports: [
        {
          user: { login: 'owner' },
          body: approved.replace('`merge`', '`human_decision`'),
          submitted_at: '2026-10-01T12:00:00Z',
        },
      ],
    },
    {
      comments: [
        {
          user: { login: 'owner' },
          body: approved.replace('`merge`', '`fix`'),
          created_at: '2026-10-02T12:00:00Z',
        },
      ],
    },
    { noChecks: true },
    { changedHead: true },
    { identity: 'other' },
    { acceptanceEnabled: false },
    { badScope: true },
  ])('fails closed without merge for unsafe review/configuration: %j', async (options) => {
    const { publisher, run } = fixture(options);
    await expect(publisher.accept(input)).rejects.toThrow();
    expect(run.mock.calls.some((c) => c[1][1] === 'merge')).toBe(false);
  });
  it('accepts an already-ready review without repeating the ready mutation', async () => {
    const { publisher, run } = fixture({ alreadyReady: true });
    expect(await publisher.accept(input)).toMatchObject({ state: 'accepted', head });
    expect(run.mock.calls.some((c) => c[1][1] === 'ready')).toBe(false);
  });
  it('does not declare acceptance when merge command did not merge', async () => {
    await expect(fixture({ mergeFails: true }).publisher.accept(input)).rejects.toThrow();
  });
  it('rejects user-controlled repository, branch, URL, and draft identity before any call', async () => {
    for (const patch of [
      { repository: 'other/repo' },
      { baseBranch: 'other' },
      { url: input.url + '?x=1' },
      { draftId: '--admin' },
      { head: 'bad' },
    ]) {
      const { publisher, run } = fixture();
      await expect(publisher.inspect({ ...input, ...patch })).rejects.toThrow();
      expect(run).not.toHaveBeenCalled();
    }
  });
  it('inspect is read-only and reports gate blocking details', async () => {
    const { publisher, run } = fixture({ reports: [] });
    expect(await publisher.inspect(input)).toMatchObject({
      state: 'in-review',
      head,
      canAccept: false,
    });
    expect(run.mock.calls.some((c) => ['ready', 'merge'].includes(c[1][1]))).toBe(false);
  });
});

describe('send Knowledge draft for review', () => {
  it('marks the exact saved head ready without requiring approval or acceptance enrollment', async () => {
    const { publisher, run } = fixture({ reports: [], noChecks: true, acceptanceEnabled: false });
    expect(await publisher.sendForReview(input)).toEqual({
      state: 'in-review',
      head,
      draft: false,
      canAccept: false,
    });
    expect(run.mock.calls.filter((c) => c[1][1] === 'ready')).toHaveLength(1);
    expect(run.mock.calls.filter((c) => c[1].some((a) => a.endsWith('/pulls/7')))).toHaveLength(3);
    expect(
      run.mock.calls.some(
        (c) =>
          ['checks', 'merge'].includes(c[1][1]) ||
          c[1].some((a) => a.endsWith('/reviews') || a.endsWith('/comments')),
      ),
    ).toBe(false);
  });
  it('is idempotent for an already-ready saved head', async () => {
    const { publisher, run } = fixture({ alreadyReady: true });
    expect(await publisher.sendForReview(input)).toMatchObject({ draft: false, head });
    expect(run.mock.calls.some((c) => c[1][1] === 'ready')).toBe(false);
  });
  it.each([
    { head: 'b'.repeat(40) },
    { repository: 'other/repo' },
    { baseBranch: 'wrong' },
    { url: input.url + '?x=1' },
  ])('rejects mismatching review input before ready: %j', async (patch) => {
    const { publisher, run } = fixture();
    await expect(publisher.sendForReview({ ...input, ...patch })).rejects.toThrow();
    expect(run.mock.calls.some((c) => c[1][1] === 'ready')).toBe(false);
  });
  it.each([{ closed: true }, { changedHead: true }, { identity: 'other' }, { badScope: true }])(
    'blocks unavailable or changed reviews before ready: %j',
    async (options) => {
      const { publisher, run } = fixture(options);
      await expect(publisher.sendForReview(input)).rejects.toThrow();
      expect(run.mock.calls.some((c) => c[1][1] === 'ready')).toBe(false);
    },
  );
  it.each([{ changedAfterReady: true }, { readyFails: true }])(
    'verifies the same head became ready before returning a receipt: %j',
    async (options) => {
      const { publisher, run } = fixture(options);
      await expect(publisher.sendForReview(input)).rejects.toThrow();
      expect(run.mock.calls.some((c) => c[1][1] === 'merge')).toBe(false);
    },
  );
  it('honors authorization revocation before any call or before ready mutation', async () => {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const first = fixture();
    await expect(
      first.publisher.sendForReview({ ...input, signal: alreadyAborted.signal }),
    ).rejects.toThrow();
    expect(first.run).not.toHaveBeenCalled();
    const duringRead = new AbortController();
    const second = fixture({
      onRead: (count) => {
        if (count === 2) duringRead.abort();
      },
    });
    await expect(
      second.publisher.sendForReview({ ...input, signal: duringRead.signal }),
    ).rejects.toThrow();
    expect(second.run.mock.calls.some((c) => c[1][1] === 'ready')).toBe(false);
  });
});
