import { fixture, cleanups, git } from './fixtures/prepared-repository-native-consumer.js';
import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { RepositoryWorkspaces } from '../repository-workspaces.js';
import { localRepositoryPreparationId } from '../local-repository-base.js';

it('continues the exact adopted task/HEAD after edits, commit and reopening without acquiring another source', async () => {
  const f = await fixture();
  const adopted = (await f.adopt())!;
  f.setCwd(adopted.directory);
  await writeFile(join(adopted.directory, 'retained-work.txt'), 'Completed work');
  git(adopted.directory, 'add', 'retained-work.txt');
  git(
    adopted.directory,
    '-c',
    'user.name=Offline',
    '-c',
    'user.email=offline@example.invalid',
    'commit',
    '-qm',
    'Retain completed work',
  );
  const external = new Database(join(f.root, 'repositories', 'workspaces.db'));
  cleanups.push(() => {
    external.close();
  });
  const before = external.prepare('SELECT * FROM repository_workspaces ORDER BY id').all();
  const lookup = {
    id: localRepositoryPreparationId({
      conversationId: f.first.sessionId,
      workspaceId: adopted.id,
      path: adopted.directory,
      base: { kind: 'ref', ref: 'HEAD' },
    }),
    conversationId: f.first.sessionId,
    workspace: { id: adopted.id, directory: adopted.directory },
    path: adopted.directory,
    base: { kind: 'ref' as const, ref: 'HEAD' },
    binding: f.first.lease.binding,
  };
  const cold = new RepositoryWorkspaces(join(f.root, 'repositories'), {
    authorize: async () => {
      throw Error('Continuation must not acquire credentials');
    },
  });
  cleanups.push(() => cold.close());
  expect(cold.findLocalRepositoryPreparation(lookup)?.id).toBe(adopted.id);
  expect(cold.findLocalRepositoryPreparation({ ...lookup, newCheckout: true })).toBeUndefined();
  expect(() =>
    cold.findLocalRepositoryPreparation({ ...lookup, base: { kind: 'ref', ref: 'main' } }),
  ).toThrow('pending_host_task_base_conflict');
  expect(() =>
    cold.findLocalRepositoryPreparation({
      ...lookup,
      binding: { ...lookup.binding, accountId: 'other' },
    }),
  ).toThrow();
  expect(() =>
    cold.findLocalRepositoryPreparation({
      ...lookup,
      workspace: { ...lookup.workspace, directory: '/substituted' },
    }),
  ).toThrow();
  expect(external.prepare('SELECT * FROM repository_workspaces ORDER BY id').all()).toEqual(before);
  // External writers cannot be hidden by process-local reuse or the previous lookup.
  const raw = (
    external.prepare('SELECT record FROM repository_workspaces WHERE id=?').get(adopted.id) as {
      record: string;
    }
  ).record;
  const changed = JSON.parse(raw);
  delete changed.preparedRepositoryTransitionAdoption;
  external
    .prepare('UPDATE repository_workspaces SET record=? WHERE id=?')
    .run(JSON.stringify(changed), adopted.id);
  expect(() => cold.findLocalRepositoryPreparation(lookup)).toThrow();
  external.prepare('UPDATE repository_workspaces SET record=? WHERE id=?').run(raw, adopted.id);
  expect(cold.findLocalRepositoryPreparation(lookup)?.id).toBe(adopted.id);
  expect(git(adopted.directory, 'show', 'HEAD:retained-work.txt')).toBe('Completed work');
}, 120000);
