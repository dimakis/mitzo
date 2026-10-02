import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { expect, it } from 'vitest';

const head = 'a'.repeat(40);
const body = `<!-- centaur:sha:${head} -->\n## Centaur Review\nLGTM — no issues found.\n**Recommendation:** \`merge\`\n- New blocking findings: 0\n- Unresolved blocking findings: 0\n`;
const script = readFileSync('.github/workflows/centaur-gate.yml', 'utf8')
  .split('          script: |\n')[1]
  .split('\n')
  .map((line) => line.slice(12))
  .join('\n');
const review = { user: { login: 'dimakis' }, body, commit_id: head, state: 'COMMENTED' };

async function execute(
  records: Partial<typeof review>[],
  current = head,
  next = current,
  reviewer = '',
  event: Record<string, unknown> = { pull_request: { number: 704 } },
) {
  const statuses: { state: string; sha: string; context: string }[] = [];
  let reads = 0;
  const github = {
    rest: {
      pulls: {
        get: async () => ({ data: { state: 'open', head: { sha: reads++ ? next : current } } }),
        listReviews: 'reviews',
        list: 'pulls',
      },
      issues: { listComments: 'comments' },
      repos: {
        createCommitStatus: async (status: (typeof statuses)[number]) => statuses.push(status),
      },
    },
    paginate: async (endpoint: string) =>
      endpoint === 'reviews'
        ? records
        : endpoint === 'pulls'
          ? [{ number: 704, head: { ref: 'topic', repo: { full_name: 'fork/mitzo' } } }]
          : [],
  };
  await new Script(`(async () => {${script}})()`).runInNewContext({
    github,
    process: { env: { CENTAUR_REVIEWER_LOGIN: reviewer } },
    context: {
      repo: { owner: 'dimakis', repo: 'mitzo' },
      payload: event,
    },
  });
  return statuses;
}

it('sets the required status only for a final current-head Centaur approval', async () => {
  const statuses = await execute([review]);
  expect(statuses.map((s) => s.state)).toEqual(['pending', 'success']);
  expect(statuses.every((s) => s.sha === head && s.context === 'Centaur final LGTM')).toBe(true);
});

it.each([
  [[], 'pending'],
  [[{ ...review, user: { login: 'untrusted' } }], 'pending'],
  [[{ ...review, state: 'DISMISSED' }], 'failure'],
  [[{ ...review, body: body.replace('`merge`', '`human_decision`') }], 'failure'],
  [
    [
      {
        ...review,
        body: body.replace('Unresolved blocking findings: 0', 'Unresolved blocking findings: 2'),
      },
    ],
    'failure',
  ],
] as const)('blocks unverified or blocking verdicts', async (records, state) => {
  expect((await execute([...records])).at(-1)?.state).toBe(state);
});

it('never carries an older approval onto a new head', async () => {
  expect((await execute([review], 'b'.repeat(40))).at(-1)?.state).toBe('pending');
  expect((await execute([review], head, 'b'.repeat(40))).some((s) => s.state === 'success')).toBe(
    false,
  );
});

it('accepts only the configured trusted Centaur publishing account', async () => {
  expect(
    (await execute([{ ...review, user: { login: 'centaur-bot' } }], head, head, 'centaur-bot')).at(
      -1,
    )?.state,
  ).toBe('success');
  expect((await execute([review], head, head, 'centaur-bot')).at(-1)?.state).toBe('pending');
});

it('resolves fork review signals through canonical PR metadata', async () => {
  const statuses = await execute([review], head, head, '', {
    workflow_run: {
      pull_requests: [],
      head_repository: { full_name: 'fork/mitzo' },
      head_branch: 'topic',
    },
  });
  expect(statuses.at(-1)?.state).toBe('success');
});

it('separates PR-controlled review signals from trusted status writes', () => {
  const gate = readFileSync('.github/workflows/centaur-gate.yml', 'utf8');
  const signal = readFileSync('.github/workflows/centaur-review-signal.yml', 'utf8');
  expect(gate).not.toContain('  pull_request_review:');
  expect(gate).toContain('workflows: [Centaur review signal]');
  expect(signal).not.toContain('statuses: write');
  expect(signal).not.toContain('actions/checkout');
});
