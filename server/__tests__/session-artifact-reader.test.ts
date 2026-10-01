import { it, expect, vi } from 'vitest';
import type { AccountBinding } from '@mitzo/protocol';
import { createSessionArtifactReader } from '../session-artifact-reader.js';

const binding = {
  accountId: 'account',
  provider: 'openai',
  model: 'model',
  profileRevision: '1',
} as AccountBinding;
const runtime = {
  sandboxId: 'physical',
  sandboxName: 'owned',
  workdir: '/sandbox/workspaces/mgmt',
  cli: '/bin/openshell',
  gateway: 'gateway',
  workspace: 'workspace',
  gatewayInsecure: false,
  appServerCommand: '/sandbox/run-mitzo-app-server' as const,
};
const route = { kind: 'api' as const, provider: 'provider', model: 'model' };
function deps() {
  return {
    readRuntime: vi.fn(() => ({ runtime, route })),
    currentRoute: vi.fn(() => route),
    validateRuntime: vi.fn(),
    inspect: vi.fn().mockResolvedValue({ id: 'physical', phase: 'Ready' }),
    read: vi
      .fn()
      .mockResolvedValue({ path: `${runtime.workdir}/report.md`, bytes: Buffer.from('# Report') }),
  };
}
it.each(['openai', 'openai-codex'])(
  'reads an inactive %s conversation using persisted exact runtime',
  async (provider) => {
    const d = deps();
    const selected = { ...binding, provider } as AccountBinding;
    const result = await createSessionArtifactReader(d)(
      'old-session',
      selected,
      runtime.workdir,
      'report.md',
    );
    expect(result.bytes.toString()).toBe('# Report');
    expect(d.readRuntime).toHaveBeenCalledWith('old-session', selected);
    expect(d.inspect).toHaveBeenCalledTimes(2);
    expect(d.read).toHaveBeenCalledWith(
      runtime,
      'report.md',
      expect.any(AbortSignal),
      expect.any(Function),
    );
  },
);
it('fails closed when old conversation has no pinned runtime', async () => {
  const d = deps();
  d.readRuntime.mockReturnValue(null as never);
  await expect(
    createSessionArtifactReader(d)('old', binding, runtime.workdir, 'report.md'),
  ).rejects.toMatchObject({ status: 409 });
  expect(d.read).not.toHaveBeenCalled();
});
it.each(['Stopped', 'Deleted'])('does not restore a %s workspace on GET', async (phase) => {
  const d = deps();
  d.inspect.mockResolvedValue({ id: 'physical', phase });
  await expect(
    createSessionArtifactReader(d)('old', binding, runtime.workdir, 'report.md'),
  ).rejects.toMatchObject({ status: 409 });
  expect(d.read).not.toHaveBeenCalled();
});
it('rejects a replaced sandbox and changed subscription route', async () => {
  const d = deps();
  d.inspect.mockResolvedValue({ id: 'replacement', phase: 'Ready' });
  await expect(
    createSessionArtifactReader(d)('old', binding, runtime.workdir, 'report.md'),
  ).rejects.toMatchObject({ status: 409 });
  expect(d.read).not.toHaveBeenCalled();
  const e = deps();
  e.currentRoute.mockReturnValue({ ...route, provider: 'other' });
  await expect(
    createSessionArtifactReader(e)('old', binding, runtime.workdir, 'report.md'),
  ).rejects.toMatchObject({ status: 409 });
  expect(e.read).not.toHaveBeenCalled();
});
it('rejects workspace mismatch and disappearance after read', async () => {
  const d = deps();
  await expect(
    createSessionArtifactReader(d)('old', binding, '/sandbox/other', 'report.md'),
  ).rejects.toMatchObject({ status: 409 });
  expect(d.read).not.toHaveBeenCalled();
  const e = deps();
  e.inspect
    .mockResolvedValueOnce({ id: 'physical', phase: 'Ready' })
    .mockResolvedValueOnce(undefined);
  await expect(
    createSessionArtifactReader(e)('old', binding, runtime.workdir, 'report.md'),
  ).rejects.toMatchObject({ status: 409 });
});
