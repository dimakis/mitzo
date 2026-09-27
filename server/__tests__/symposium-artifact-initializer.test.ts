import { expect, it, vi } from 'vitest';
import { initializeArtifactGit, artifactGitContract } from '../symposium-artifact-initializer.js';
import { symposiumArtifactOwner } from '../symposium-artifact-owner.js';
const owner = symposiumArtifactOwner(
  'sha256:a5a5302f2443c02f24506248883b9d22f070f58b288f898ac69a547b653e2161',
);
const helperId = 'a'.repeat(64);
function fixture() {
  const events: string[] = [];
  const receipt = {
    intent: vi.fn((name: string) => {
      events.push(`intent:${name}`);
    }),
    created: vi.fn((id: string) => {
      events.push(`created:${id}`);
    }),
    removed: vi.fn(() => {
      events.push('removed');
    }),
  };
  const command = vi.fn(async (args: readonly string[]) => {
    events.push(args[0]);
    return args[0] === 'create'
      ? helperId
      : args[0] === 'start'
        ? 'MITZO_GIT_INITIALIZED_V1\n'
        : '';
  });
  return { events, receipt, command, custody: vi.fn() };
}
it('journals intent and exact helper ID before init, removes exact ID before success', async () => {
  const f = fixture();
  await initializeArtifactGit('mitzo-artifacts-test', owner, f.command, f.custody, f.receipt);
  expect(f.events).toEqual([
    'intent:mitzo-artifacts-test-init',
    'create',
    `created:${helperId}`,
    'start',
    'rm',
    'removed',
  ]);
  expect(f.command.mock.calls[1][0]).toEqual(['start', '--attach', helperId]);
  expect(f.command.mock.calls[2][0]).toEqual(['rm', helperId]);
  const create = f.command.mock.calls[0][0];
  expect(create).toEqual(
    expect.arrayContaining([
      '--network=none',
      '--read-only',
      '--timeout=20',
      '--pull=never',
      owner.image,
    ]),
  );
  expect(artifactGitContract(owner)).not.toBe(JSON.stringify(owner));
});
it('does not start or remove an unknown create outcome', async () => {
  const f = fixture();
  f.command.mockRejectedValueOnce(new Error('timeout'));
  await expect(
    initializeArtifactGit('mitzo-artifacts-test', owner, f.command, f.custody, f.receipt),
  ).rejects.toThrow();
  expect(f.events).toEqual(['intent:mitzo-artifacts-test-init']);
  expect(f.receipt.created).not.toHaveBeenCalled();
  expect(f.receipt.removed).not.toHaveBeenCalled();
});
it('does not start after ID receipt persistence fails or delete an unjournaled helper', async () => {
  const f = fixture();
  f.receipt.created.mockImplementation(() => {
    throw new Error('crash');
  });
  await expect(
    initializeArtifactGit('mitzo-artifacts-test', owner, f.command, f.custody, f.receipt),
  ).rejects.toThrow('crash');
  expect(f.command).toHaveBeenCalledOnce();
});
it('retains failed start and cleanup uncertainty for recovery without automatic mutation retries', async () => {
  const f = fixture();
  f.command.mockImplementation(async (args) => {
    f.events.push(args[0]);
    if (args[0] === 'create') return helperId;
    throw new Error('uncertain');
  });
  await expect(
    initializeArtifactGit('mitzo-artifacts-test', owner, f.command, f.custody, f.receipt),
  ).rejects.toThrow();
  expect(f.events).toEqual([
    'intent:mitzo-artifacts-test-init',
    'create',
    `created:${helperId}`,
    'start',
  ]);
  expect(f.receipt.removed).not.toHaveBeenCalled();
});
it('does not report initialization success after cleanup fails', async () => {
  const f = fixture();
  f.command.mockImplementation(async (args) => {
    if (args[0] === 'create') return helperId;
    if (args[0] === 'start') return 'MITZO_GIT_INITIALIZED_V1\n';
    throw new Error('cleanup uncertain');
  });
  await expect(
    initializeArtifactGit('mitzo-artifacts-test', owner, f.command, f.custody, f.receipt),
  ).rejects.toThrow('cleanup uncertain');
  expect(f.receipt.removed).not.toHaveBeenCalled();
});

it('binds the reviewed canonical target in the persisted initialization contract', () => {
  expect(JSON.parse(artifactGitContract(owner))).toMatchObject({
    target: '/sandbox/workspaces/mgmt',
  });
});
