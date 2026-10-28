import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ModelSession, ModelSessionConfig } from '@mitzo/harness';
import type { AdviserRequest } from '../terminal-adviser.js';
import type { AdviserFeatureOwner } from '../adviser-harness-runtime.js';
import { createOrdinaryPublicationReview } from '../ordinary-publication-review.js';
import { capturePublicationReviewEvidence } from '../ordinary-publication-review-context.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mitzo-publication-review-'));
  roots.push(directory);
  const git = (...args: string[]) =>
    execFileSync('/usr/bin/git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Offline review fixture');
  git('config', 'user.email', 'review@example.invalid');
  await mkdir(join(directory, 'docs'));
  await writeFile(
    join(directory, 'AGENTS.md'),
    'Preserve unrelated task work. Read [route requirements](docs/requirements.md).',
  );
  await writeFile(
    join(directory, 'docs/requirements.md'),
    'The unchanged route must preserve the documented response status.',
  );
  await writeFile(join(directory, 'change.ts'), 'export const answer = 1;\n');
  await writeFile(
    join(directory, 'route.ts'),
    "import { answer } from './change.js';\nexport const route = () => ({ status: 200, answer });\n",
  );
  await writeFile(
    join(directory, 'change.test.ts'),
    "import { route } from './route.js';\n// Unchanged route test requires status 200 and the changed helper result.\n",
  );
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('switch', '-qc', 'mitzo/task');
  await writeFile(join(directory, 'change.ts'), 'export const answer = 2;\n');
  git('add', 'change.ts');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture change');
  const sourceOid = git('rev-parse', 'HEAD');
  const current = vi.fn();
  const owner = {
    authSessionId: 'auth',
    operatorConnectionId: 'operator',
    binding: {
      accountId: 'offline',
      provider: 'openai-codex',
      model: 'gpt-6-luna',
      profileRevision: 'offline',
    },
    model: 'gpt-6-luna',
    reasoningEffort: 'low',
    assertCurrent: current,
    assertCurrentSync: current,
  };
  let verdict = 'approve';
  let blocker = false;
  let nonBlocking = false;
  const contexts: string[] = [];
  const session = vi.fn(
    async (_config: ModelSessionConfig, _request: AdviserRequest, _owner?: AdviserFeatureOwner) =>
      ({
        provider: 'codex',
        async *turn(messages: Array<{ role: string; content: string }>) {
          for (const message of messages)
            expect(Buffer.from(message.content, 'utf8').toString('utf8')).toBe(message.content);
          const supplied = messages.map((m) => m.content).join('');
          contexts.push(supplied);
          const match = /Evidence SHA-256: ([a-f0-9]{64})/.exec(supplied)!;
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'text_delta',
              text: JSON.stringify({
                evidenceSha256: match[1],
                reviewedAllEvidence: true,
                verdict,
                findings: blocker
                  ? [{ severity: 'blocking', path: 'change.ts', summary: 'A defect' }]
                  : nonBlocking
                    ? [
                        {
                          severity: 'non_blocking',
                          path: 'route.ts',
                          summary: 'Document the unchanged route contract',
                        },
                      ]
                    : [],
              }),
            },
          };
        },
      }) as unknown as ModelSession,
  );
  const review = createOrdinaryPublicationReview({ resolveOwner: () => owner, session });
  const input = {
    operation: { id: 'operation', accountId: 'offline', conversationId: 'chat' },
    repository: 'example/repo',
    baseBranch: 'main',
    sourceBranch: 'mitzo/task',
    sourceOid,
    directory,
    bundle: Buffer.from('opaque host-verified bundle'),
    signal: new AbortController().signal,
  } as Parameters<typeof review>[0];
  return {
    directory,
    git,
    input,
    owner,
    current,
    session,
    contexts,
    review,
    setVerdict: (v: string) => {
      verdict = v;
    },
    setBlocker: () => {
      blocker = true;
    },
    setNonBlocking: () => {
      nonBlocking = true;
    },
  };
}
it('runs two independent tool-less reviews on complete committed text and pins their exact evidence', async () => {
  const f = await fixture();
  f.setNonBlocking();
  const receipt = await f.review(f.input);
  expect(f.session).toHaveBeenCalledTimes(2);
  expect(f.session.mock.calls[0][0]).toMatchObject({
    model: 'gpt-6-luna',
    tools: [],
    reasoningEffort: 'low',
  });
  expect(f.session.mock.calls[0][0].systemPrompt).not.toBe(f.session.mock.calls[1][0].systemPrompt);
  expect(f.session.mock.calls[0][2]).toMatchObject({
    authSessionId: 'auth',
    operatorConnectionId: 'operator',
    feature: { kind: 'github-publication', operationId: 'operation' },
  });
  expect(f.contexts[0]).toContain('export const answer = 2;');
  expect(f.contexts[0]).toContain('Preserve unrelated task work.');
  for (const context of f.contexts) {
    expect(context).toContain('export const route =');
    expect(context).toContain('Unchanged route test requires status 200');
    expect(context).toContain('The unchanged route must preserve the documented response status.');
  }
  expect(f.contexts[0]).not.toContain(f.directory);
  expect(receipt.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(receipt.reports).toMatchObject([
    {
      reportId: expect.any(String),
      accountId: 'offline',
      model: 'gpt-6-luna',
      verdict: 'approve',
      coverage: { changedPaths: ['change.ts'], unresolvedNeeds: [] },
    },
    {
      reportId: expect.any(String),
      accountId: 'offline',
      model: 'gpt-6-luna',
      verdict: 'approve',
      coverage: { changedPaths: ['change.ts'], unresolvedNeeds: [] },
    },
  ]);
  expect(receipt.reports?.[0].findings).toEqual([
    {
      severity: 'non_blocking',
      path: 'route.ts',
      summary: 'Document the unchanged route contract',
    },
  ]);
  expect(f.contexts[1]).not.toContain('Document the unchanged route contract');
  await expect(receipt.assertCurrent(f.input)).resolves.toBeUndefined();
  f.git('update-ref', 'refs/remotes/origin/main', f.input.sourceOid);
  await expect(receipt.assertCurrent(f.input)).rejects.toThrow();
});

it('serves bounded Git context requests independently for each pass and reports exact partial coverage', async () => {
  const f = await fixture();
  const large = [
    "import { answer } from './change.js';",
    'export const requiredBoundary = answer;',
    ...Array.from({ length: 2500 }, (_, i) => `// Unchanged context line ${i}`),
  ].join('\n');
  await writeFile(join(f.directory, 'large-caller.ts'), large);
  f.git('add', '.');
  f.git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'unchanged large caller');
  f.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  await writeFile(join(f.directory, 'change.ts'), 'export const answer = 3;\n');
  f.git('add', 'change.ts');
  f.git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'reviewed helper change');
  const rounds: string[] = [];
  f.session.mockImplementation(
    async (config) =>
      ({
        provider: 'codex',
        async *turn(messages: Array<{ role: string; content: string }>) {
          const context = messages.map((message) => message.content).join('');
          rounds.push(context);
          const digest = [...context.matchAll(/Evidence SHA-256: ([a-f0-9]{64})/g)].at(-1)![1];
          const requested = context.includes('"contextResponse"');
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'text_delta',
              text: JSON.stringify({
                evidenceSha256: digest,
                reviewedAllEvidence: requested,
                verdict: requested ? 'approve' : 'context_required',
                findings: [],
                requests: requested
                  ? []
                  : [
                      { kind: 'read', path: 'large-caller.ts', startLine: 1, endLine: 2 },
                      { kind: 'search', query: './route.js' },
                    ],
                unresolvedNeeds: [],
              }),
            },
          };
          expect(config.tools).toEqual([]);
        },
      }) as unknown as ModelSession,
  );
  const receipt = await f.review({ ...f.input, sourceOid: f.git('rev-parse', 'HEAD') });
  expect(f.session).toHaveBeenCalledTimes(4);
  expect(rounds[1]).toContain('export const requiredBoundary = answer;');
  expect(rounds[3]).toContain('export const requiredBoundary = answer;');
  expect(rounds[1]).toContain('"remainingAfter":2500');
  expect(rounds[2]).not.toContain('"contextResponse"');
  expect(receipt.reports?.[0].coverage.contextReads).toContainEqual(
    expect.objectContaining({ path: 'large-caller.ts', startLine: 1, endLine: 2, complete: false }),
  );
});

it('refuses unresolved needed context and invalid Git paths', async () => {
  const f = await fixture();
  f.session.mockImplementation(
    async () =>
      ({
        provider: 'codex',
        async *turn(messages: Array<{ role: string; content: string }>) {
          const digest = /Evidence SHA-256: ([a-f0-9]{64})/.exec(
            messages.map((message) => message.content).join(''),
          )![1];
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'text_delta',
              text: JSON.stringify({
                evidenceSha256: digest,
                reviewedAllEvidence: true,
                verdict: 'approve',
                findings: [],
                unresolvedNeeds: ['An unchanged caller still needs inspection'],
              }),
            },
          };
        },
      }) as unknown as ModelSession,
  );
  await expect(f.review(f.input)).rejects.toMatchObject({ code: 'PUBLICATION_REVIEW_BLOCKED' });
  f.session.mockImplementation(
    async () =>
      ({
        provider: 'codex',
        async *turn(messages: Array<{ role: string; content: string }>) {
          const digest = /Evidence SHA-256: ([a-f0-9]{64})/.exec(
            messages.map((message) => message.content).join(''),
          )![1];
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'text_delta',
              text: JSON.stringify({
                evidenceSha256: digest,
                reviewedAllEvidence: false,
                verdict: 'context_required',
                findings: [],
                requests: [{ kind: 'read', path: '../outside-secret' }],
              }),
            },
          };
        },
      }) as unknown as ModelSession,
  );
  await expect(f.review(f.input)).rejects.toMatchObject({
    code: 'PUBLICATION_REVIEW_UNAVAILABLE',
    details: { reason: 'context_path_unavailable' },
  });
});

it('rechecks the original publisher at actual adviser dispatch after asynchronous setup', async () => {
  const f = await fixture();
  const turn = vi.fn(async function* () {});
  let capturedOwner: AdviserFeatureOwner | undefined;
  f.session.mockImplementation(async (config, _request, featureOwner) => {
    capturedOwner = featureOwner;
    f.current.mockImplementation(() => {
      throw Error('publisher changed during setup');
    });
    await config.beforeDispatch?.();
    return { provider: 'codex', turn } as unknown as ModelSession;
  });
  await expect(f.review(f.input)).rejects.toThrow();
  expect(turn).not.toHaveBeenCalled();
  expect(capturedOwner?.assertCurrentSync).toBe(f.owner.assertCurrentSync);
});

it('returns incomplete when context requests exhaust the bounded rounds instead of approving a partial pass', async () => {
  const f = await fixture();
  f.session.mockImplementation(
    async () =>
      ({
        provider: 'codex',
        async *turn(messages: Array<{ role: string; content: string }>) {
          const digest = /Evidence SHA-256: ([a-f0-9]{64})/.exec(
            messages.map((message) => message.content).join(''),
          )![1];
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'text_delta',
              text: JSON.stringify({
                evidenceSha256: digest,
                reviewedAllEvidence: false,
                verdict: 'context_required',
                findings: [],
                requests: [{ kind: 'read', path: 'route.ts', startLine: 1, endLine: 1 }],
              }),
            },
          };
        },
      }) as unknown as ModelSession,
  );
  await expect(f.review(f.input)).rejects.toMatchObject({
    code: 'PUBLICATION_REVIEW_UNAVAILABLE',
    details: { reason: 'context_round_limit' },
  });
  expect(f.session).toHaveBeenCalledTimes(5);
});
it.each(['changes_requested', 'incomplete'])(
  'does not approve %s or hide its findings',
  async (verdict) => {
    const f = await fixture();
    f.setVerdict(verdict);
    await expect(f.review(f.input)).rejects.toThrow(/review/i);
    expect(f.session).toHaveBeenCalledTimes(1);
  },
);
it('refuses an approve verdict with a blocking finding', async () => {
  const f = await fixture();
  f.setBlocker();
  await expect(f.review(f.input)).rejects.toThrow(/defect|review/i);
});
it('does not run inference for another account or a cancelled/revoked owner', async () => {
  const f = await fixture();
  await expect(
    f.review({ ...f.input, operation: { ...f.input.operation, accountId: 'other' } }),
  ).rejects.toThrow();
  f.current.mockImplementation(() => {
    throw Error('revoked');
  });
  await expect(f.review(f.input)).rejects.toThrow('revoked');
  expect(f.session).not.toHaveBeenCalled();
});
it('rejects oversized committed evidence before inference rather than approving truncated content', async () => {
  const f = await fixture();
  await writeFile(join(f.directory, 'large.txt'), 'x'.repeat(2000000));
  f.git('add', 'large.txt');
  f.git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'large fixture');
  await expect(
    f.review({ ...f.input, sourceOid: f.git('rev-parse', 'HEAD') }),
  ).rejects.toMatchObject({
    code: 'PUBLICATION_REVIEW_UNAVAILABLE',
    details: { reason: 'evidence_limit' },
  });
  expect(f.session).not.toHaveBeenCalled();
});
it('bounds expensive runtime qualification by evidence batches and refuses a revoked batch', async () => {
  const f = await fixture();
  for (let index = 0; index < 24; index++)
    await writeFile(join(f.directory, `context-${index}.ts`), `export const value = ${index};\n`);
  f.git('add', '.');
  f.git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'review many changed files');
  const assertRuntimeCurrent = vi.fn(async () => {});
  const input = { ...f.input, sourceOid: f.git('rev-parse', 'HEAD'), assertRuntimeCurrent };
  const captured = await capturePublicationReviewEvidence(input);
  expect(captured.packet.changedPaths).toHaveLength(25);
  expect(assertRuntimeCurrent.mock.calls.length).toBeLessThan(8);
  assertRuntimeCurrent.mockClear();
  await captured.context([{ kind: 'read', path: 'route.ts' }]);
  expect(assertRuntimeCurrent.mock.calls.length).toBeGreaterThanOrEqual(2);
  expect(assertRuntimeCurrent.mock.calls.length).toBeLessThan(8);
  let checks = 0;
  await expect(
    capturePublicationReviewEvidence({
      ...input,
      assertRuntimeCurrent: async () => {
        if (++checks > 1) throw Error('Original runtime revoked during immutable reads');
      },
    }),
  ).rejects.toThrow('Original runtime revoked');
  expect(f.session).not.toHaveBeenCalled();
});
it('reviews complete large source and generated context without dropping unchanged content', async () => {
  const f = await fixture();
  const content = '/* retained complete context for an independently reviewed change */\n😀'.repeat(
    4000,
  );
  for (const path of ['generated.ts', 'design.md'])
    await writeFile(join(f.directory, path), content);
  f.git('add', '.');
  f.git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'large reviewed base');
  f.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  for (const path of ['generated.ts', 'design.md'])
    await writeFile(join(f.directory, path), content + 'end-of-reviewed-file\n');
  f.git('add', '.');
  f.git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'small change with large context');
  await f.review({ ...f.input, sourceOid: f.git('rev-parse', 'HEAD') });
  expect(f.session).toHaveBeenCalledTimes(2);
  expect(f.contexts[0].match(/retained complete context/g)).toHaveLength(8006);
  expect(f.contexts[0]).toContain('end-of-reviewed-file');
});
