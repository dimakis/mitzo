import { AdviserHarnessFailure } from '../adviser-harness-failure.js';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ModelSession, ModelSessionConfig } from '@mitzo/harness';
import type { AdviserRequest } from '../terminal-adviser.js';
import type { AdviserFeatureOwner } from '../adviser-harness-runtime.js';
import {
  createOrdinaryPublicationReview,
  type OrdinaryPublicationReviewOwner,
} from '../ordinary-publication-review.js';
import { capturePublicationReviewEvidence } from '../ordinary-publication-review-context.js';
import { parsePublicationReviewResponse } from '../ordinary-publication-review-response.js';

it('reports invalid review fields without copying the model explanation', () => {
  const secret = 'sensitive explanation '.repeat(20);
  let failure: unknown;
  try {
    parsePublicationReviewResponse(
      JSON.stringify({
        evidenceSha256: 'a'.repeat(64),
        reviewedAllEvidence: false,
        verdict: 'incomplete',
        findings: [],
        unresolvedNeeds: [secret],
      }),
    );
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    details: {
      reason: 'review_response_invalid_schema',
      phase: 'response_validation',
      issues: [{ field: 'unresolvedNeeds.0', code: 'too_big', limit: 200 }],
    },
  });
  expect(JSON.stringify(failure)).not.toContain(secret);
});
import {
  publicationReviewDependencies,
  publicationReviewImports,
  boundedReviewDependencyCandidates,
} from '../ordinary-publication-review-dependencies.js';

it('discovers only pinned literal dependencies without interpreting shell expressions', () => {
  const binding = 'root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\n';
  const all = new Set(['scripts/lib/actual.sh', 'scripts/lib/missing.js', 'scripts/lib/actual.ts']);
  expect([
    ...publicationReviewImports('scripts/entry.sh', binding + 'bash "$root/lib/actual.sh"', all),
  ]).toEqual([]);
  expect([
    ...publicationReviewDependencies(
      'scripts/entry.sh',
      binding + 'bash "$root/lib/actual.sh"',
      all,
    ),
  ]).toEqual(['scripts/lib/actual.sh']);
  for (const source of [
    binding + 'root=/elsewhere\nbash "$root/lib/actual.sh"',
    binding + 'export root=/elsewhere\nbash "$root/lib/actual.sh"',
    binding + 'bash "$root/$(outside)/actual.sh"',
    'root=/elsewhere\nbash "$root/lib/actual.sh"',
    binding + 'bash "$root/lib/untracked.sh"',
  ])
    expect([...publicationReviewDependencies('scripts/entry.sh', source, all)]).toEqual([]);
  const bounded = boundedReviewDependencyCandidates(
    new Set(Array.from({ length: 130 }, (_, i) => `path-${i}`)),
    128,
  );
  expect(bounded.paths).toHaveLength(128);
  expect(bounded.omittedCount).toBe(2);
  expect(boundedReviewDependencyCandidates(new Set(['unread']), 0)).toEqual({
    paths: [],
    omittedCount: 1,
  });
  expect([
    ...publicationReviewDependencies('scripts/entry.ts', "import './lib/actual.js';", all),
  ]).toEqual(['scripts/lib/actual.ts']);
});

it('rejects malformed reviewer output with bounded schema diagnostics and no response text', () => {
  const valid = {
    evidenceSha256: 'a'.repeat(64),
    reviewedAllEvidence: false,
    verdict: 'context_required',
    findings: [],
    requests: [{ kind: 'read', path: 'entry.sh' }],
    unresolvedNeeds: ['x'.repeat(242)],
  };
  for (const [text, expected] of [
    [
      JSON.stringify(valid),
      {
        reason: 'review_response_invalid_schema',
        phase: 'response_validation',
        issues: [{ field: 'unresolvedNeeds.0', code: 'too_big', limit: 200 }],
      },
    ],
    [
      'PRIVATE_PROVIDER_RESPONSE {',
      { reason: 'review_response_invalid_json', phase: 'response_validation' },
    ],
  ] as const) {
    try {
      parsePublicationReviewResponse(text);
      throw Error('Unexpected acceptance');
    } catch (error) {
      expect(error).toMatchObject({ code: 'PUBLICATION_REVIEW_UNAVAILABLE', details: expected });
      expect(JSON.stringify(error)).not.toContain('PRIVATE_PROVIDER_RESPONSE');
    }
  }
  expect(() =>
    parsePublicationReviewResponse(
      JSON.stringify({ ...valid, unresolvedNeeds: ['x'.repeat(200)] }),
    ),
  ).not.toThrow();
  const unknown = JSON.stringify({
    ...valid,
    unresolvedNeeds: [],
    SECRET_UNKNOWN_KEY: 'PRIVATE_SECRET',
  });
  expect(() => parsePublicationReviewResponse(unknown)).toThrow();
  try {
    parsePublicationReviewResponse(unknown);
  } catch (error) {
    expect(JSON.stringify(error)).not.toContain('SECRET');
  }
});

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
      accountLabel: 'Offline review account',
      provider: 'openai-codex',
      model: 'gpt-6-luna',
      profileRevision: 'offline',
    },
    model: 'gpt-6-luna',
    reasoningEffort: 'low',
    assertCurrent: current,
    assertCurrentSync: current,
  } satisfies OrdinaryPublicationReviewOwner;
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
  for (const [config] of f.session.mock.calls) {
    expect(config.systemPrompt).toContain('This is inference round 1 of 5');
    expect(config.systemPrompt).toContain('Batch all currently known context needs');
    expect(config.systemPrompt).toContain('existing representative coverage');
    expect(config.systemPrompt).toContain('Each unresolvedNeeds entry must fit 200 characters');
    const schema = JSON.parse(config.systemPrompt.split('Response JSON schema: ')[1]);
    expect(schema.properties.unresolvedNeeds.items.maxLength).toBe(200);
    expect(schema.properties.findings.items.properties.summary.maxLength).toBe(600);
    expect(schema.properties.requests.maxItems).toBe(8);
  }

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
  const packet = JSON.parse(f.contexts[0].split('(JSON):\n')[1]).initialEvidence;
  expect(packet.contextDiscovery.candidates).toContainEqual(
    expect.objectContaining({
      path: 'docs/requirements.md',
      reason: 'instruction_link',
      linkedFrom: ['AGENTS.md'],
    }),
  );
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

it('reviews the task delta from its pinned merge base while retaining the advanced base tip', async () => {
  const f = await fixture();
  const mergeBaseOid = f.git('rev-parse', 'refs/remotes/origin/main');
  const deletedContent = f.git('show', `${mergeBaseOid}:route.ts`) + '\n';
  f.git('rm', 'route.ts');
  f.git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'remove task route');
  const sourceOid = f.git('rev-parse', 'HEAD');
  f.git('switch', '-q', 'main');
  await writeFile(join(f.directory, 'change.ts'), 'export const answer = 99;\n');
  await writeFile(join(f.directory, 'route.ts'), 'Main-only replacement route\n');
  await writeFile(join(f.directory, 'main-only.txt'), 'Accepted main-only content\n');
  f.git('add', '.');
  f.git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'advance accepted main');
  const baseOid = f.git('rev-parse', 'HEAD');
  f.git('update-ref', 'refs/remotes/origin/main', baseOid);
  f.git('switch', '-q', 'mitzo/task');
  const input = { ...f.input, sourceOid };
  const captured = await capturePublicationReviewEvidence(input);
  expect(captured.packet).toMatchObject({ baseOid, mergeBaseOid, sourceOid });
  expect(captured.packet.changedPaths).toEqual(['change.ts', 'route.ts']);
  expect(captured.packet.diff).toContain('-export const answer = 1;');
  expect(captured.packet.diff).not.toContain('answer = 99');
  expect(captured.text).not.toContain('Accepted main-only content');
  expect(captured.packet.contents).toContainEqual({
    path: 'route.ts',
    revision: 'merge-base',
    content: deletedContent,
  });
  const receipt = await f.review(input);
  expect(f.session).toHaveBeenCalledTimes(2);
  f.git('update-ref', 'refs/remotes/origin/main', mergeBaseOid);
  await expect(receipt.assertCurrent(input)).rejects.toThrow();
});

it('does not charge main-only files against the task changed-file or evidence bounds', async () => {
  const f = await fixture();
  const mergeBaseOid = f.git('rev-parse', 'refs/remotes/origin/main');
  f.git('switch', '-q', 'main');
  await Promise.all(
    Array.from({ length: 65 }, (_, index) =>
      writeFile(join(f.directory, `main-only-${index}.txt`), 'x'.repeat(13000)),
    ),
  );
  f.git('add', '.');
  f.git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'large independent main advance');
  const baseOid = f.git('rev-parse', 'HEAD');
  f.git('update-ref', 'refs/remotes/origin/main', baseOid);
  f.git('switch', '-q', 'mitzo/task');
  const captured = await capturePublicationReviewEvidence(f.input);
  expect(captured.packet).toMatchObject({ baseOid, mergeBaseOid });
  expect(captured.packet.changedPaths).toEqual(['change.ts']);
  expect(captured.text).not.toContain('main-only-');
  await expect(f.review(f.input)).resolves.toHaveProperty('evidenceSha256');
});

it.each(['unrelated', 'ambiguous'] as const)(
  'refuses %s merge-base history before inference',
  async (history) => {
    const f = await fixture();
    const rootOid = f.git('rev-parse', 'refs/remotes/origin/main');
    const rootTree = f.git('rev-parse', `${rootOid}^{tree}`);
    let sourceOid = f.input.sourceOid;
    let baseOid: string;
    if (history === 'unrelated')
      baseOid = f.git('commit-tree', rootTree, '-m', 'unrelated accepted root');
    else {
      const other = f.git('commit-tree', rootTree, '-p', rootOid, '-m', 'other task');
      const sourceTree = f.git('rev-parse', `${sourceOid}^{tree}`);
      const originalSource = sourceOid;
      sourceOid = f.git(
        'commit-tree',
        sourceTree,
        '-p',
        originalSource,
        '-p',
        other,
        '-m',
        'task merge',
      );
      baseOid = f.git(
        'commit-tree',
        rootTree,
        '-p',
        other,
        '-p',
        originalSource,
        '-m',
        'base merge',
      );
      f.git('update-ref', 'refs/heads/mitzo/task', sourceOid);
    }
    f.git('update-ref', 'refs/remotes/origin/main', baseOid);
    await expect(f.review({ ...f.input, sourceOid })).rejects.toMatchObject({
      code: 'PUBLICATION_REVIEW_UNAVAILABLE',
      details: { reason: 'merge_base_unavailable' },
    });
    expect(f.session).not.toHaveBeenCalled();
  },
);

it('serves bounded Git context requests independently for each pass and reports exact partial coverage', async () => {
  const f = await fixture();
  const large = [
    "import { answer } from './change.js';",
    'export const requiredBoundary = answer;',
    ...Array.from({ length: 2500 }, (_, i) =>
      i === 2499 ? "import './partial-only.js';" : `// Unchanged context line ${i}`,
    ),
  ].join('\n');
  await writeFile(join(f.directory, 'large-caller.ts'), large);
  await writeFile(join(f.directory, 'partial-only.ts'), 'UNREAD_PARTIAL_DEPENDENCY');
  await mkdir(join(f.directory, 'scripts/lib'), { recursive: true });
  const entry =
    'script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\nbash "$script_root/lib/implementation.sh"\n';
  await writeFile(
    join(f.directory, 'scripts/lib/implementation.sh'),
    '# Complete delegated selection boundary\n' +
      '# preserved implementation line\n'.repeat(500) +
      'root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\nbash "$root/indirect.sh"\n',
  );
  await Promise.all([
    writeFile(join(f.directory, 'scripts/lib/indirect.sh'), 'UNREAD_RECURSIVE_DEPENDENCY'),
    writeFile(join(f.directory, 'scripts/empty.sh'), ''),
    writeFile(join(f.directory, 'scripts/empty-explicit.sh'), ''),
    writeFile(join(f.directory, 'scripts/blob.dat'), Buffer.from([0xff])),
    writeFile(join(f.directory, 'scripts/other.sh'), entry),
  ]);
  await mkdir(join(f.directory, 'scripts/guarded'), { recursive: true });
  await writeFile(
    join(f.directory, 'scripts/guarded/AGENTS.md'),
    'UNREAD_INSTRUCTION'.repeat(3000),
  );
  await writeFile(
    join(f.directory, 'scripts/guarded/implementation.sh'),
    '# UNREAD_GUARDED_DEPENDENCY\n',
  );
  await writeFile(join(f.directory, 'scripts/huge.sh'), '# UNREAD_LARGE_DEPENDENCY\n'.repeat(3000));
  await writeFile(
    join(f.directory, 'scripts/entry.sh'),
    entry +
      'bash "$script_root/empty.sh"\nbash "$script_root/blob.dat"\n' +
      'bash "$script_root/huge.sh"\nbash "$script_root/guarded/implementation.sh"\n' +
      Array.from({ length: 10 }, (_, i) => `bash "$script_root/lib/tiny-${i}.sh"\n`).join(''),
  );
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      writeFile(join(f.directory, `scripts/lib/tiny-${i}.sh`), '# tiny deterministic dependency\n'),
    ),
  );
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
                      { kind: 'read', path: 'scripts/entry.sh' },
                      { kind: 'read', path: 'scripts/other.sh' },
                      { kind: 'read', path: 'scripts/empty-explicit.sh' },
                      { kind: 'search', query: './route.js' },
                      { kind: 'search', query: './route.js', pathPrefix: '' },
                      { kind: 'search', query: './route.js', pathPrefix: '.' },
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
  for (const index of [1, 3]) {
    expect(rounds[index]).toContain('Complete delegated selection boundary');
    expect(rounds[index]).not.toContain('UNREAD_INSTRUCTION');
    expect(rounds[index]).not.toContain('UNREAD_PARTIAL_DEPENDENCY');
    expect(rounds[index]).not.toContain('UNREAD_RECURSIVE_DEPENDENCY');
    expect(rounds[index]).toContain('non_text_dependency_or_instruction');
    expect(rounds[index]).toContain('already_supplied_or_requested');
    expect(rounds[index]).not.toContain('UNREAD_GUARDED_DEPENDENCY');
    expect(rounds[index]).not.toContain('UNREAD_LARGE_DEPENDENCY');
    expect(rounds[index]).toContain('automatic_context_budget');
    expect(rounds[index]).toContain('automatic_file_budget');
    expect(rounds[index].match(/preserved implementation line/g)).toHaveLength(500);
  }
  expect(receipt.reports?.[0].coverage.contextReads).toContainEqual(
    expect.objectContaining({
      path: 'scripts/lib/implementation.sh',
      complete: true,
      totalLines: 503,
    }),
  );
  expect(rounds[3]).toContain('export const requiredBoundary = answer;');
  expect(rounds[1]).toContain('"remainingAfter":2500');
  expect(rounds[2]).not.toContain('"contextResponse"');
  const responses = JSON.parse(rounds[1].split('(JSON):\n')[1]).history[0].contextResponse;
  const entryResponse = responses.find(
    (response: { path?: string }) => response.path === 'scripts/entry.sh',
  );
  expect(entryResponse.dependencies).toContainEqual(
    expect.objectContaining({
      path: 'scripts/empty.sh',
      totalLines: 0,
      startLine: 0,
      endLine: 0,
      complete: true,
    }),
  );
  expect(responses).toContainEqual(
    expect.objectContaining({
      path: 'scripts/empty-explicit.sh',
      totalLines: 0,
      startLine: 0,
      endLine: 0,
      complete: true,
    }),
  );
  expect(receipt.reports?.[0].coverage.searches).toEqual([
    { query: './route.js', matchedPathCount: 1 },
    { query: './route.js', matchedPathCount: 1 },
    { query: './route.js', matchedPathCount: 1 },
  ]);

  expect(receipt.reports?.[0].coverage.contextReads).toContainEqual(
    expect.objectContaining({ path: 'large-caller.ts', startLine: 1, endLine: 2, complete: false }),
  );
});

it('refuses unresolved needed context and invalid Git paths', async () => {
  const f = await fixture();
  const captured = await capturePublicationReviewEvidence(f.input);
  for (const pathPrefix of ['..', '../outside', '/tmp', 'src/../']) {
    await expect(
      captured.context([{ kind: 'search', query: 'answer', pathPrefix }]),
    ).rejects.toMatchObject({
      code: 'PUBLICATION_REVIEW_UNAVAILABLE',
      details: { reason: 'context_search_unavailable' },
    });
  }

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
  let round = 0;
  f.session.mockImplementation(
    async (config) =>
      ({
        provider: 'codex',
        async *turn(messages: Array<{ role: string; content: string }>) {
          round++;
          expect(config.systemPrompt).toContain(`This is inference round ${round} of 5`);
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
                requests:
                  round === 5
                    ? [{ kind: 'search', query: 'unavailable-final-context', pathPrefix: '.' }]
                    : [{ kind: 'read', path: 'route.ts', startLine: 1, endLine: 1 }],
              }),
            },
          };
        },
      }) as unknown as ModelSession,
  );
  await expect(f.review(f.input)).rejects.toMatchObject({
    code: 'PUBLICATION_REVIEW_UNAVAILABLE',
    details: {
      reason: 'context_round_limit',
      requests: [{ kind: 'search', query: 'unavailable-final-context' }],
    },
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
  let contextChecks = 0;
  assertRuntimeCurrent.mockImplementation(async () => {
    if (++contextChecks > 1) throw Error('Original runtime revoked during requested context');
  });
  await expect(captured.context([{ kind: 'read', path: 'route.ts' }])).rejects.toThrow(
    'Original runtime revoked during requested context',
  );
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

it('delivers only a bounded native failure phase to the publication caller without retrying', async () => {
  const f = await fixture();
  f.session.mockRejectedValueOnce(new AdviserHarnessFailure('session_metadata'));
  await expect(f.review(f.input)).rejects.toMatchObject({
    code: 'PUBLICATION_REVIEW_UNAVAILABLE',
    details: { reason: 'review_response_unavailable', phase: 'session_metadata' },
  });
  expect(f.session).toHaveBeenCalledOnce();
});
