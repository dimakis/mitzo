import { expect, it, vi } from 'vitest';
import { collectPersonalAdmissionEvidence } from '../symposium-personal-evidence.js';
const selection = {
  personalConnection: { connectionId: 'slot', expectedRevision: 3 },
  sessionId: 'session',
  allowedRoles: ['coder', 'reviewer'],
};
function fixture() {
  const assertCurrent = vi.fn();
  const capture = vi.fn(() => ({
    provider: {
      name: 'provider',
      id: 'pid',
      type: 'codex' as const,
      profileName: 'codex' as const,
    },
    assertCurrent,
  }));
  const mapping = {
    sessionId: 'session',
    workspaceId: 'workspace',
    volumeName: 'volume',
    volumeGeneration: 'generation',
  };
  const getReady = vi.fn(() => mapping);
  const collect = vi.fn(async (input: unknown) => input);
  return { capture, getReady, collect, assertCurrent };
}
it('derives exact provider and ready session volume without accepting caller provider identities', async () => {
  const f = fixture();
  const result = await collectPersonalAdmissionEvidence(selection, f);
  expect(result).toEqual({
    providerInstances: [{ name: 'provider', id: 'pid', type: 'codex', profileName: 'codex' }],
    artifactVolume: { driver: 'podman', name: 'volume' },
    allowedRoles: ['coder', 'reviewer'],
    allowedAccountProviders: ['openai-codex'],
  });
  expect(f.capture).toHaveBeenCalledWith({ connectionId: 'slot', expectedRevision: 3 });
  expect(f.assertCurrent).toHaveBeenCalledTimes(3);
  await expect(
    collectPersonalAdmissionEvidence({ ...selection, providerInstances: [] }, f),
  ).rejects.toThrow();
});
it('rejects slot changes during asynchronous collection', async () => {
  const f = fixture();
  f.collect.mockImplementation(async (input) => {
    f.assertCurrent.mockImplementation(() => {
      throw Error('slot changed');
    });
    return input;
  });
  await expect(collectPersonalAdmissionEvidence(selection, f)).rejects.toThrow('slot changed');
});
it('rejects missing, cross-session and changed volume mappings', async () => {
  const f = fixture();
  f.getReady.mockReturnValue({ ...f.getReady(), sessionId: 'other' });
  await expect(collectPersonalAdmissionEvidence(selection, f)).rejects.toThrow();
  expect(f.collect).not.toHaveBeenCalled();
  const g = fixture();
  g.collect.mockImplementation(async (input) => {
    g.getReady.mockReturnValue({ ...g.getReady(), volumeName: 'other' });
    return input;
  });
  await expect(collectPersonalAdmissionEvidence(selection, g)).rejects.toThrow();
});
