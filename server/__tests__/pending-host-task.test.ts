import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import * as filesystem from 'fs/promises';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AccountBinding } from '@mitzo/protocol';
import { RepositoryWorkspaces } from '../repository-workspaces.js';

vi.mock('fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs/promises')>();
  return { ...original, mkdir: vi.fn(original.mkdir) };
});

vi.setConfig({ testTimeout: 20_000 });

const roots: string[] = [];
const services: RepositoryWorkspaces[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(filesystem.mkdir).mockReset();
  services.splice(0).forEach((service) => service.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
const binding = {
  accountId: 'offline',
  accountLabel: 'Offline fixtures',
  provider: 'openai' as const,
  model: 'offline-model',
  profileRevision: 'profile-1',
} satisfies AccountBinding;
const runtime = {
  version: 2 as const,
  account: { accountId: 'offline', provider: 'openai' as const, profileRevision: 'profile-1' },
  harness: { implementation: 'codex' as const },
  execution: { location: 'local' as const, targetId: 'mac', targetRevision: 'mac-1' },
};
const selection = {
  runOn: 'local' as const,
  runtime: { account: runtime.account, harness: 'codex' as const, targetId: 'mac' },
};
const signal = () => AbortSignal.timeout(30000);
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    },
  ).trim();
function fixture(objectFormat: 'sha1' | 'sha256' = 'sha1') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'existing-repository-owner-')));
  roots.push(root);
  const repositories = ['unrelated-web', 'unrelated-library'].map((name) => {
    const path = join(root, name);
    git(root, 'init', '--template=', '-q', '-b', 'main', `--object-format=${objectFormat}`, path);
    git(path, 'config', 'user.name', 'Offline');
    git(path, 'config', 'user.email', 'offline@example.invalid');
    writeFileSync(join(path, 'AGENTS.md'), `Instructions for ${name}\n`);
    writeFileSync(join(path, 'code.txt'), `Original ${name}\n`);
    git(path, 'add', '.');
    git(path, 'commit', '-qm', 'fixture base');
    return path;
  });
  const taskRoot = join(root, 'tasks');
  mkdirSync(taskRoot, { mode: 0o700 });
  const deps = {
    // No enrollment or configured registry. Access is always rechecked by the host owner.
    assertLocalRepositoryAccess: vi.fn(async (_path: string, _context: unknown) => {}),
    authorize: vi.fn(async () => {
      throw Error('Unexpected remote authorization');
    }),
    ordinaryPreparation: {
      capture: vi.fn(async () => ({
        version: 1 as const,
        originalBinding: binding,
        runtimeBinding: runtime,
        credentialDigest: 'a'.repeat(64),
      })),
      assert: vi.fn(async () => {}),
    },
  };
  const current = vi.fn((_request: unknown) => {});
  const access = vi.fn(async (_request: unknown, _access: unknown) => {});
  const authority = {
    assertPendingHostTaskCurrentSync: current,
    assertPendingHostTaskAccess: access,
  };
  const open = (withAuthority = true) => {
    const service = new RepositoryWorkspaces(join(root, 'private'), {
      ...deps,
      ...(withAuthority ? authority : {}),
    });
    services.push(service);
    return service;
  };
  const reservation = (id: string, conversationId = 'same-conversation') => ({
    id,
    binding,
    conversationId,
    taskRoot,
    runtimeBinding: runtime,
    commandFingerprint: 'b'.repeat(64),
    signal: signal(),
  });
  const request = (id: string) => ({
    id,
    binding,
    conversationId: 'same-conversation',
    runtimeId: 'owned-runtime',
    runtimeBinding: runtime,
    nativeTarget: {
      commandId: 'command-1',
      attempt: 1,
      threadId: 'native-thread',
      turnId: 'native-turn',
      generation: 0,
    },
    prepareCallId: 'prepare-call-1',
    requestHash: 'c'.repeat(64),
    taskRoot,
  });
  const record = (id: string) => {
    const db = new Database(join(root, 'private', 'workspaces.db'), { readonly: true });
    try {
      return db
        .prepare('SELECT record,conversation_id FROM repository_workspaces WHERE id=?')
        .get(id) as { record: string; conversation_id: string | null };
    } finally {
      db.close();
    }
  };
  return {
    root,
    repositories,
    taskRoot,
    deps,
    open,
    reservation,
    request,
    record,
    current,
    access,
  };
}

async function selected(service: RepositoryWorkspaces, path: string) {
  return service.selectExistingLocalRepository(binding, path, selection, signal());
}

it('materializes two unrelated pending tasks while retaining the primary conversation, dirty source and old custody', async () => {
  const f = fixture();
  const service = f.open();
  const old = await selected(service, f.repositories[0]);
  await service.reserveHostTask(f.reservation(old.id));
  const primary = await service.claimReservedHostTask(f.reservation(old.id));
  const oldRow = f.record(old.id);
  writeFileSync(join(primary.directory!, 'code.txt'), 'Unfinished primary edits\n');
  for (const path of f.repositories) {
    writeFileSync(join(path, 'code.txt'), 'Source dirty\n');
    git(path, 'add', 'code.txt');
    writeFileSync(join(path, '.env'), 'FIXTURE_SECRET=private\n');
    const before = git(path, 'status', '--porcelain=v1');
    const ready = await selected(service, path);
    const request = f.request(ready.id);
    const receipt = await service.reservePendingHostTask(request, signal());
    expect(receipt.state).toBe('reserved');
    expect(existsSync(receipt.directory)).toBe(false);
    const materialized = await service.materializePendingHostTask(request, signal());
    expect(materialized.state).toBe('materialized');
    expect(materialized.taskIdentity).toBeDefined();
    expect(readFileSync(join(materialized.directory, 'AGENTS.md'), 'utf8')).toContain(
      'Instructions for',
    );
    expect(readFileSync(join(materialized.directory, 'code.txt'), 'utf8')).toContain('Original');
    expect(existsSync(join(materialized.directory, '.env'))).toBe(false);
    expect(git(path, 'status', '--porcelain=v1')).toBe(before);
    const row = f.record(ready.id);
    const stored = JSON.parse(row.record);
    expect(stored.state).toBe('ready');
    expect(row.conversation_id).toBeNull();
    expect(stored.conversationId).toBeUndefined();
    expect(stored.directory).toBeUndefined();
    expect(service.getForConversation('same-conversation')?.id).toBe(old.id);
    expect(service.getPendingHostTask(request)).toEqual(materialized);
  }
  expect(f.record(old.id)).toEqual(oldRow);
  expect(readFileSync(join(primary.directory!, 'code.txt'), 'utf8')).toBe(
    'Unfinished primary edits\n',
  );
});

it('fails closed without private current/write authority before filesystem effects', async () => {
  const f = fixture();
  const service = f.open(false);
  const ready = await selected(service, f.repositories[0]);
  const before = f.record(ready.id);
  await expect(service.reservePendingHostTask(f.request(ready.id), signal())).rejects.toMatchObject(
    { code: 'pending_host_task_authority_required' },
  );
  expect(f.record(ready.id)).toEqual(before);
  expect(filesystem.mkdir).not.toHaveBeenCalled();
});

it('denies product operation write authority without task creation or source changes', async () => {
  const f = fixture();
  const service = f.open();
  const ready = await selected(service, f.repositories[0]);
  const before = f.record(ready.id);
  const status = git(f.repositories[0], 'status', '--porcelain=v1');
  f.access.mockImplementation(async (_request, access) => {
    if ((access as { operation: string }).operation === 'write') throw Error('Denied');
  });
  await expect(service.reservePendingHostTask(f.request(ready.id), signal())).rejects.toMatchObject(
    { code: 'pending_host_task_access_required' },
  );
  expect(f.record(ready.id)).toEqual(before);
  expect(git(f.repositories[0], 'status', '--porcelain=v1')).toBe(status);
  expect(filesystem.mkdir).not.toHaveBeenCalled();
});

it.each([
  'commandId',
  'attempt',
  'generation',
  'prepareCallId',
  'requestHash',
  'runtimeId',
] as const)('rejects another %s selection before touching the reserved task', async (field) => {
  const f = fixture();
  const service = f.open();
  const ready = await selected(service, f.repositories[0]);
  const request = f.request(ready.id);
  const original = await service.reservePendingHostTask(request, signal());
  const wrong = structuredClone(request);
  if (field === 'commandId') wrong.nativeTarget.commandId = 'another-command';
  else if (field === 'attempt' || field === 'generation') wrong.nativeTarget[field]++;
  else wrong[field] = 'd'.repeat(64);
  expect(() => service.getPendingHostTask(wrong)).toThrow();
  await expect(service.materializePendingHostTask(wrong, signal())).rejects.toThrow();
  expect(service.getPendingHostTask(request)).toEqual(original);
  expect(existsSync(original.directory)).toBe(false);
});

it('revalidates a materialized dirty task with a fresh owner after reconnect without copying or retargeting', async () => {
  const f = fixture();
  const service = f.open();
  const ready = await selected(service, f.repositories[1]);
  const request = f.request(ready.id);
  await service.reservePendingHostTask(request, signal());
  const original = await service.materializePendingHostTask(request, signal());
  writeFileSync(join(original.directory, 'code.txt'), 'Pending task edits\n');
  service.close();
  services.splice(services.indexOf(service), 1);
  const resumed = f.open();
  const after = await resumed.revalidatePendingHostTask(request, signal());
  expect(after).toEqual(original);
  expect(await resumed.materializePendingHostTask(request, signal())).toEqual(original);
  expect(readFileSync(join(original.directory, 'code.txt'), 'utf8')).toBe('Pending task edits\n');
});

it('requires an existing canonical task root and never creates a missing destination root', async () => {
  const f = fixture();
  const service = f.open();
  const ready = await selected(service, f.repositories[0]);
  const request = { ...f.request(ready.id), taskRoot: join(f.root, 'missing-tasks') };
  await expect(service.reservePendingHostTask(request, signal())).rejects.toThrow();
  expect(existsSync(request.taskRoot)).toBe(false);
  expect(filesystem.mkdir).not.toHaveBeenCalled();
});

it('checks current operation again after awaited authorization and leaves reservation untouched on revocation', async () => {
  const f = fixture();
  const service = f.open();
  const ready = await selected(service, f.repositories[0]);
  const request = f.request(ready.id);
  const reserved = await service.reservePendingHostTask(request, signal());
  let revoked = false;
  f.current.mockImplementation(() => {
    if (revoked) throw Error('Current call revoked');
  });
  f.access.mockImplementation(async () => {
    revoked = true;
  });
  await expect(service.materializePendingHostTask(request, signal())).rejects.toThrow(
    'Current call revoked',
  );
  expect(service.getPendingHostTask(request)).toEqual(reserved);
  expect(existsSync(reserved.directory)).toBe(false);
});

it('does not retain caller objects and rejects changed account or target bindings', async () => {
  const f = fixture();
  const service = f.open();
  const ready = await selected(service, f.repositories[0]);
  const request = f.request(ready.id);
  const original = structuredClone(request);
  await service.reservePendingHostTask(request, signal());
  request.nativeTarget.generation++;
  request.runtimeBinding.execution.targetRevision = 'changed';
  expect(service.getPendingHostTask(original).request).toEqual(original);
  expect(() => service.getPendingHostTask(request)).toThrow();
  const accountChanged = structuredClone(original);
  accountChanged.runtimeBinding.account.accountId = 'other-account';
  await expect(service.materializePendingHostTask(accountChanged, signal())).rejects.toMatchObject({
    code: 'pending_host_task_invalid_input',
  });
  await expect(service.reserveHostTask(f.reservation(ready.id))).rejects.toThrow();
  await expect(service.discard(ready.id, binding)).rejects.toThrow();
});

it.each(['directory', 'branch', 'administration'] as const)(
  'preserves an unowned %s collision without adopting it',
  async (collision) => {
    const f = fixture();
    const service = f.open();
    const ready = await selected(service, f.repositories[0]);
    const request = f.request(ready.id);
    const receipt = await service.reservePendingHostTask(request, signal());
    if (collision === 'directory') {
      mkdirSync(receipt.directory);
      writeFileSync(join(receipt.directory, 'unowned.txt'), 'Foreign edits');
    }
    if (collision === 'branch') git(f.repositories[0], 'branch', `mitzo/repo-${ready.id}`);
    if (collision === 'administration') {
      mkdirSync(join(f.repositories[0], '.git', 'worktrees', `repo-${ready.id}`), {
        recursive: true,
      });
      writeFileSync(
        join(f.repositories[0], '.git', 'worktrees', `repo-${ready.id}`, 'unowned.txt'),
        'Foreign administration',
      );
    }
    await expect(service.materializePendingHostTask(request, signal())).rejects.toThrow();
    expect(service.getPendingHostTask(request).state).toBe('uncertain');
    if (collision === 'directory')
      expect(readFileSync(join(receipt.directory, 'unowned.txt'), 'utf8')).toBe('Foreign edits');
    if (collision === 'branch')
      expect(git(f.repositories[0], 'rev-parse', `mitzo/repo-${ready.id}`)).toBe(
        git(f.repositories[0], 'rev-parse', 'HEAD'),
      );
    if (collision === 'administration')
      expect(
        readFileSync(
          join(f.repositories[0], '.git', 'worktrees', `repo-${ready.id}`, 'unowned.txt'),
          'utf8',
        ),
      ).toBe('Foreign administration');
  },
);

it.each(['abort', 'revoked'] as const)(
  'retains materializing custody after %s without an expired recovery write or replay',
  async (failure) => {
    const f = fixture();
    const service = f.open();
    const ready = await selected(service, f.repositories[1]);
    const request = f.request(ready.id);
    const receipt = await service.reservePendingHostTask(request, signal());
    const abort = new AbortController();
    let revoked = false;
    f.current.mockImplementation(() => {
      if (revoked) throw Error('Current operation expired');
    });
    f.access.mockImplementation(async () => {
      if (existsSync(join(receipt.directory, '.git'))) {
        if (failure === 'abort') abort.abort(Error('Interrupted after allocation'));
        else revoked = true;
      }
    });
    await expect(service.materializePendingHostTask(request, abort.signal)).rejects.toThrow(
      failure === 'abort' ? 'Interrupted after allocation' : 'Current operation expired',
    );
    const interrupted = f.record(ready.id);
    expect(JSON.parse(interrupted.record).pendingHostTask.state).toBe('materializing');
    expect(service.getPendingHostTask(request).state).toBe('uncertain');
    expect(f.record(ready.id)).toEqual(interrupted);
    expect(existsSync(join(receipt.directory, '.git'))).toBe(true);
    expect(existsSync(join(receipt.directory, 'code.txt'))).toBe(false);
    writeFileSync(join(receipt.directory, 'retained.txt'), 'Keep partial work');
    service.close();
    services.splice(services.indexOf(service), 1);
    f.access.mockImplementation(async () => {});
    revoked = false;
    const resumed = f.open();
    await expect(resumed.materializePendingHostTask(request, signal())).rejects.toMatchObject({
      code: 'pending_host_task_uncertain',
    });
    expect(JSON.parse(f.record(ready.id).record).pendingHostTask.state).toBe('uncertain');
    const afterRecovery = f.record(ready.id);
    await expect(resumed.materializePendingHostTask(request, signal())).rejects.toMatchObject({
      code: 'pending_host_task_uncertain',
    });
    expect(f.record(ready.id)).toEqual(afterRecovery);
    expect(readFileSync(join(receipt.directory, 'retained.txt'), 'utf8')).toBe('Keep partial work');
  },
);

it('projects a crashed materializing record conservatively without getter writes, and current recovery never replays it', async () => {
  const f = fixture();
  const service = f.open();
  const ready = await selected(service, f.repositories[0]);
  const request = f.request(ready.id);
  await service.reservePendingHostTask(request, signal());
  const row = f.record(ready.id);
  const record = JSON.parse(row.record);
  record.pendingHostTask.state = 'materializing';
  const db = new Database(join(f.root, 'private', 'workspaces.db'));
  db.prepare('UPDATE repository_workspaces SET record=? WHERE id=?').run(
    JSON.stringify(record),
    ready.id,
  );
  db.close();
  const before = f.record(ready.id);
  expect(service.getPendingHostTask(request).state).toBe('uncertain');
  expect(f.record(ready.id)).toEqual(before);
  await expect(service.revalidatePendingHostTask(request, signal())).rejects.toMatchObject({
    code: 'pending_host_task_uncertain',
  });
  expect(JSON.parse(f.record(ready.id).record).pendingHostTask.state).toBe('uncertain');
  expect(existsSync(join(f.taskRoot, `repo-${ready.id}`))).toBe(false);
});
