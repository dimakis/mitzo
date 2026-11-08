import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  realpathSync,
  lstatSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { memberScope } from '../task-execution-scope.js';
import { nativeCommandApprovalScope } from '../codex-native-approval-scope.js';
import type { NativeApprovalRequest } from '../codex-native-permission-protocol.js';

const directories: string[] = [];
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, lstatSync: vi.fn(fs.lstatSync) };
});
afterEach(() => {
  vi.mocked(lstatSync).mockReset();
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true }));
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-scope-')));
  directories.push(root);
  const cwd = join(root, 'task');
  const nested = join(cwd, 'implementation', 'repo');
  const outside = join(root, 'other-task');
  mkdirSync(nested, { recursive: true });
  mkdirSync(outside);
  const owner = {
    runtimeId: 'runtime',
    environmentId: 'local',
    mode: 'agent',
    cwd,
    deniedRoots: [],
    writeProtectedRoots: [],
  };
  const request: NativeApprovalRequest = {
    method: 'item/commandExecution/requestApproval',
    id: 'rpc',
    params: {
      kind: 'command',
      command: 'npm test -- focused',
      cwd: nested,
      threadId: 'thread',
      turnId: 'turn',
      itemId: 'item',
      startedAtMs: Date.now(),
      environmentId: 'local',
    },
  };
  return { cwd, nested, outside, owner, request };
}
it('retains exact commands in a nested task directory across turns', () => {
  const { request, owner } = fixture();
  const first = nativeCommandApprovalScope(request, owner);
  expect(first).toMatch(/^native-command-v1:/);
  request.params.turnId = 'next-turn';
  expect(nativeCommandApprovalScope(request, owner)).toBe(first);
});
it('does not treat another task or a path prefix as a nested task directory', () => {
  const { request, owner, outside, cwd } = fixture();
  if (request.method !== 'item/commandExecution/requestApproval') throw Error('fixture');
  for (const path of [outside, cwd + '-other', join(cwd, '..', 'other-task')]) {
    request.params.cwd = path;
    expect(nativeCommandApprovalScope(request, owner)).toBeUndefined();
  }
});
it('does not reuse consent through an escaping directory alias', () => {
  const { request, owner, outside, cwd } = fixture();
  symlinkSync(outside, join(cwd, 'escape'));
  if (request.method !== 'item/commandExecution/requestApproval') throw Error('fixture');
  request.params.cwd = join(cwd, 'escape');
  expect(nativeCommandApprovalScope(request, owner)).toBeUndefined();
});
it('binds nested consent to the directory identity, command and native thread', () => {
  const { request, owner, nested } = fixture();
  if (request.method !== 'item/commandExecution/requestApproval') throw Error('fixture');
  const first = nativeCommandApprovalScope(request, owner);
  expect(first).toBeDefined();
  expect(
    nativeCommandApprovalScope(
      { ...request, params: { ...request.params, command: 'npm test -- another' } },
      owner,
    ),
  ).not.toBe(first);
  expect(
    nativeCommandApprovalScope(
      { ...request, params: { ...request.params, threadId: 'another-thread' } },
      owner,
    ),
  ).not.toBe(first);
  rmSync(nested, { recursive: true });
  mkdirSync(nested);
  expect(nativeCommandApprovalScope(request, owner)).not.toBe(first);
});

it('rejects inode reuse without invalidating ordinary file writes', async () => {
  const { request, owner, nested } = fixture();
  const original = await vi.importActual<typeof import('node:fs')>('node:fs');
  let incarnation = 1n;
  vi.mocked(lstatSync).mockImplementation((path, options) => {
    const stat = original.lstatSync(path, options);
    if (String(path) === nested) Object.defineProperty(stat, 'birthtimeNs', { value: incarnation });
    return stat;
  });
  const session = { cwd: nested, worktreePaths: new Map() } as never;
  const consent = nativeCommandApprovalScope(request, owner);
  const member = memberScope('worker', session);
  writeFileSync(join(nested, 'result.txt'), 'test output');
  expect(nativeCommandApprovalScope(request, owner)).toBe(consent);
  expect(memberScope('worker', session)).toEqual(member);
  incarnation = 2n;
  expect(nativeCommandApprovalScope(request, owner)).not.toBe(consent);
  expect(memberScope('worker', session).fingerprint).not.toBe(member.fingerprint);
  incarnation = 0n;
  expect(nativeCommandApprovalScope(request, owner)).toBeUndefined();
  expect(() => memberScope('worker', session)).toThrow(/physical task directory/);
});
