import { expect, it, vi } from 'vitest';
import { captureRoutingConsole } from '../symposium-routing-console.js';
import { discoveryClaimLabel } from '../symposium-model-discovery.js';
function fixture() {
  const receipt = {
    name: `md-${'a'.repeat(16)}`,
    id: 'sandbox-1',
    claim: 'b'.repeat(64),
    configHash: 'c'.repeat(64),
  };
  const image = `sha256:${'d'.repeat(64)}`;
  const row = {
    Id: 'e'.repeat(64),
    Names: ['openshell-supervisor-sandbox-1'],
    Labels: {
      'openshell.ai/sandbox-id': receipt.id,
      'openshell.ai/sandbox-name': receipt.name,
      'openshell.ai/sandbox-workspace': 'work',
      'openshell.ai/sandbox-namespace': 'default',
      'openshell.ai/isolation-role': 'supervisor',
      'openshell.ai/managed': 'true',
      'mitzo.discovery': 'models',
      'mitzo.discovery.claim': discoveryClaimLabel(receipt.claim),
    },
  };
  const input = {
    receipt,
    workspace: 'work',
    namespace: 'default',
    supervisorImage: image,
    assertCurrent: vi.fn(async () => {}),
    inventory: vi.fn(async () => [row]),
    imageDigest: vi.fn(async () => image),
    loggingFilter: vi.fn(async () => 'L'),
    readConsole: vi.fn(
      async () =>
        `2026-10-09T00:00:00.000Z DEBUG openshell.routing_http: routing diagnostic v1 kind=account_check method=GET outcome=response request_ordinal=1 status_code=403`,
    ),
  };
  return { input, row };
}
it('reads only exact claimed supervisor ID and rechecks custody/container/image around capture', async () => {
  const f = fixture();
  const result = await captureRoutingConsole(f.input);
  expect(result.observations[0].statusCode).toBe(403);
  expect(f.input.readConsole).toHaveBeenCalledExactlyOnceWith(f.row.Id);
  expect(f.input.inventory).toHaveBeenCalledTimes(2);
  expect(f.input.imageDigest).toHaveBeenCalledTimes(2);
  expect(f.input.assertCurrent).toHaveBeenCalledTimes(14);
});
it.each(['claim', 'namespace', 'workspace', 'role', 'id', 'name', 'image', 'ambiguous'] as const)(
  'refuses %s drift before reading console',
  async (kind) => {
    const f = fixture();
    if (kind === 'image') f.input.imageDigest = vi.fn(async () => `sha256:${'f'.repeat(64)}`);
    else if (kind === 'ambiguous')
      f.input.inventory = vi.fn(async () => [f.row, { ...f.row, Id: 'f'.repeat(64) }]);
    else {
      const keys = {
        claim: 'mitzo.discovery.claim',
        namespace: 'openshell.ai/sandbox-namespace',
        workspace: 'openshell.ai/sandbox-workspace',
        role: 'openshell.ai/isolation-role',
        id: 'openshell.ai/sandbox-id',
        name: 'openshell.ai/sandbox-name',
      };
      (f.row.Labels as Record<string, string>)[keys[kind]] = 'changed';
    }
    await expect(captureRoutingConsole(f.input)).rejects.toThrow();
    expect(f.input.readConsole).not.toHaveBeenCalled();
  },
);
it('discards already read console when original resource is replaced', async () => {
  const f = fixture();
  f.input.inventory
    .mockResolvedValueOnce([f.row])
    .mockResolvedValueOnce([{ ...f.row, Id: 'f'.repeat(64) }]);
  await expect(captureRoutingConsole(f.input)).rejects.toThrow();
});
it('does not continue after owner revocation or expose private command errors', async () => {
  const f = fixture();
  f.input.assertCurrent.mockRejectedValueOnce(Error('PRIVATE bearer'));
  await expect(captureRoutingConsole(f.input)).rejects.toThrow(
    'Routing observation custody changed',
  );
  expect(f.input.inventory).not.toHaveBeenCalled();
});

it.each(['', 'R', 'RL', 'LL'])(
  'refuses missing/overridden/duplicate filter marker %s',
  async (marker) => {
    const f = fixture();
    f.input.loggingFilter.mockResolvedValue(marker);
    await expect(captureRoutingConsole(f.input)).rejects.toThrow('logging filter');
    expect(f.input.readConsole).not.toHaveBeenCalled();
  },
);
