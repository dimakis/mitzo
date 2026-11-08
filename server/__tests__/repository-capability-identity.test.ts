import { expect, it, vi } from 'vitest';
import { lstatSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { capabilityFixture } from './fixtures/session-capabilities.js';
import { repositoryCapabilityIdentity } from '../repository-capability-identity.js';
const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../repository-workspace-runtime.js', () => ({
  readRepositoryWorkspaceForConversation: read,
}));
it('uses retained host custody and physical source identity, never repository text or a tool path', () => {
  const { session, root } = capabilityFixture();
  const source = join(root, 'source');
  mkdirSync(source);
  const common = join(source, '.git');
  mkdirSync(common);
  const identity = (path: string) => {
    const s = lstatSync(path);
    return { dev: s.dev, ino: s.ino };
  };
  const record = {
    id: 'workspace',
    directory: session.cwd,
    sandbox: false,
    repository: 'local/repo',
    connectionId: 'local',
    connectionRevision: 1,
    binding: session.accountBinding,
    localSource: {
      repositoryId: 'repo',
      path: source,
      root: identity(source),
      commonDirectory: common,
      commonRoot: identity(common),
    },
    taskIdentity: { directory: session.cwd, root: identity(session.cwd!) },
  };
  read.mockReturnValue(record);
  const first = repositoryCapabilityIdentity(session);
  expect(first).toBeTypeOf('string');
  read.mockReturnValue({ ...record, directory: '/other' });
  expect(repositoryCapabilityIdentity(session)).toBeUndefined();
  read.mockReturnValue({ ...record, sandbox: true });
  expect(repositoryCapabilityIdentity(session)).toBeUndefined();
  read.mockReturnValue(record);
  renameSync(common, common + '-old');
  mkdirSync(common);
  expect(repositoryCapabilityIdentity(session)).toBeUndefined();
});
