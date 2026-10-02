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

async function execute(records: Partial<typeof review>[], current = head, next = current) {
  const statuses: { state: string; sha: string; context: string }[] = [];
  let reads = 0;
  const github = {
    rest: {
      pulls: {
        get: async () => ({ data: { state: 'open', head: { sha: reads++ ? next : current } } }),
        listReviews: 'reviews',
      },
      issues: { listComments: 'comments' },
      repos: {
        createCommitStatus: async (status: (typeof statuses)[number]) => statuses.push(status),
      },
    },
    paginate: async (endpoint: string) => (endpoint === 'reviews' ? records : []),
  };
  await new Script(`(async () => {${script}})()`).runInNewContext({
    github,
    context: {
      repo: { owner: 'dimakis', repo: 'mitzo' },
      payload: { pull_request: { number: 704 } },
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
