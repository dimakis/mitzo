import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ownedRuntimeFixture } from './fixtures/owned-local-codex-runtime.js';
import { CodexConversationStore } from '../codex-conversation-store.js';
import {
  OrdinaryLocalCodexOwnedRuntime,
  type OrdinaryLocalCodexOwnedDispatch,
} from '../ordinary-local-codex-owned-runtime.js';
vi.mock('../auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth.js')>()),
  hasPersistentRevocationAuthority: () => true,
}));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('keeps a real task edit/test/build and two draft publications on the same branch across cold native resume', async () => {
  const f = await ownedRuntimeFixture(cleanups),
    first = f.create();
  await first.admit(f.request);
  const original = f.dispatch.mock.calls[0][0],
    directory = original.workspace.directory!;
  const native = new CodexConversationStore(join(f.root, 'native.db'));
  cleanups.push(() => native.close());
  native.create(original.sessionId, original.lease.binding, directory);
  original.admission.persistCustody(native);
  native.bindThread(original.sessionId, original.lease.binding, 'offline-retained-thread');
  const custody = native.readHostCustody(original.sessionId, original.lease.binding)!;
  await writeFile(join(custody.login.privateHome, 'offline-thread-history'), 'first accepted turn');

  // These are actual temp-project tools, not provider/model calls. The project
  // regression requires blanks to be ignored and duplicate labels counted once.
  const modulePath = join(directory, 'summary.ts'),
    testPath = join(directory, 'summary.test.mjs');
  await writeFile(
    modulePath,
    'export function countLabels(values: string[]): number { return values.length; }\n',
  );
  await writeFile(
    testPath,
    `import test from 'node:test';
import assert from 'node:assert/strict';
import { countLabels } from './summary.mjs';
test('ignores blanks and duplicate labels', () => assert.equal(countLabels(['task', ' task ', ' ', 'other']), 2));
`,
  );
  const build = () =>
    execFileSync(
      join(process.cwd(), 'node_modules/esbuild/bin/esbuild'),
      [
        modulePath,
        '--bundle',
        '--platform=node',
        '--format=esm',
        `--outfile=${join(directory, 'summary.mjs')}`,
      ],
      { cwd: directory, stdio: 'pipe' },
    );
  const test = () =>
    execFileSync(process.execPath, ['--test', testPath], { cwd: directory, stdio: 'pipe' });
  build();
  expect(test).toThrow();
  original.admission.assertCurrentSync();
  await writeFile(
    modulePath,
    `export function countLabels(values: string[]): number {
  return new Set(values.map(value => value.trim()).filter(Boolean)).size;
}\n`,
  );
  build();
  expect(test).not.toThrow();
  await original.admission.assertCurrent();

  const git = (...args: string[]) =>
    execFileSync(
      'git',
      ['-C', directory, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
      },
    ).trim();
  git('config', 'user.name', 'Offline Developer');
  git('config', 'user.email', 'offline@example.test');
  const publications: Array<{ prId: string; branch: string; head: string }> = [];
  const publishDraft = vi.fn(async () => {
    git('add', 'summary.ts', 'summary.test.mjs', 'summary.mjs');
    git('commit', '-qm', `offline publication ${publications.length + 1}`);
    const publication = {
      prId: 'offline-draft-42',
      branch: git('branch', '--show-current'),
      head: git('rev-parse', 'HEAD'),
    };
    publications.push(publication);
    return publication;
  });
  const firstPublication = await publishDraft();
  expect(firstPublication.branch).toBe(original.workspace.featureBranch);
  first.close();

  const next = {
    ...structuredClone(f.request),
    clientMsgId: randomUUID(),
    payload: { text: 'Continue the same draft PR' },
  };
  const dispatch = vi.fn(async (value: OrdinaryLocalCodexOwnedDispatch) => {
    expect(value.lease.privateHome).toBe(custody.login.privateHome);
    expect(await readFile(join(value.lease.privateHome, 'offline-thread-history'), 'utf8')).toBe(
      'first accepted turn',
    );
    value.admission.assertOptions({
      conversationId: value.sessionId,
      messageId: value.commandId,
      resume: true,
      binding: value.lease.binding,
      profile: value.profile,
      session: { cwd: directory, mode: 'agent' },
      prompt: value.payload.text,
      systemPrompt: value.payload.systemPrompt,
      model: value.expected.selection.model,
      reasoningEffort: value.expected.selection.thinking,
      agentProfile: value.expected.agentProfile,
      repositoryWorkspace: value.workspace,
    });
    value.admission.persistCustody(native);
    value.admission.assertBeforeEnqueue({
      id: value.commandId,
      prompt: value.payload.text,
      model: value.expected.selection.model,
      reasoningEffort: value.expected.selection.thinking,
    });
  });
  const resumed = new OrdinaryLocalCodexOwnedRuntime({
    ...f.dependencies,
    nativeStore: native,
    commandId: next.clientMsgId,
    launch: () => f.rpc,
    dispatch,
  });
  cleanups.push(() => resumed.close());
  await expect(resumed.admitResume(next)).resolves.toEqual({ dispatched: true });
  expect(git('rev-parse', 'HEAD')).toBe(firstPublication.head);
  expect(native.read(original.sessionId, original.lease.binding).threadId).toBe(
    'offline-retained-thread',
  );
  expect(test).not.toThrow();
  const resumedAdmission = dispatch.mock.calls[0][0].admission;
  resumedAdmission.assertCurrentSync();
  await writeFile(
    testPath,
    `${await readFile(testPath, 'utf8')}
test('normalizes case before deduplicating', () => assert.equal(countLabels(['Task', 'task']), 1));\n`,
  );
  expect(test).toThrow();
  await writeFile(
    modulePath,
    `export function countLabels(values: string[]): number {
  return new Set(values.map(value => value.trim().toLowerCase()).filter(Boolean)).size;
}\n`,
  );
  build();
  expect(test).not.toThrow();
  await resumedAdmission.assertCurrent();
  const secondPublication = await publishDraft();
  expect(secondPublication.prId).toBe(firstPublication.prId);
  expect(secondPublication.branch).toBe(firstPublication.branch);
  expect(secondPublication.head).not.toBe(firstPublication.head);
  expect(git('rev-parse', 'HEAD^')).toBe(firstPublication.head);
  expect(native.readHostCustody(original.sessionId, original.lease.binding)).toEqual(custody);

  // A separate task uses the original accepted source and independent checkout.
  const preview = await f.workspace.preview(
    original.lease.binding,
    'fixture-github',
    'example/repo',
    f.signal.signal,
  );
  const prepared = await f.workspace.prepare(preview.id, original.lease.binding, f.signal.signal);
  const reservation = { ...f.reservation, id: prepared.id, conversationId: randomUUID() };
  await f.workspace.reserveHostTask({ ...reservation, signal: f.signal.signal });
  const separate = await f.workspace.claimReservedHostTask({
    ...reservation,
    signal: f.signal.signal,
  });
  expect(separate.directory).not.toBe(directory);
  expect(separate.featureBranch).not.toBe(original.workspace.featureBranch);
  expect(existsSync(join(separate.directory!, 'summary.ts'))).toBe(false);
  expect(await readFile(join(separate.directory!, 'task.txt'), 'utf8')).toBe('accepted source');
  expect(git('rev-parse', 'HEAD')).toBe(secondPublication.head);
});
