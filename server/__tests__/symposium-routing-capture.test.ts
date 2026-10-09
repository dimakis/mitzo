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
  const gatewayRow = {
    id: receipt.id,
    name: receipt.name,
    workspace: 'work',
    labels: {
      'mitzo.discovery': 'models',
      'mitzo.discovery.claim': discoveryClaimLabel(receipt.claim),
    },
  };
  // Qualified native Podman build_container_labels sets openshell.managed=true;
  // the isolated supervisor inherits those common labels (native commit 9472cc767).
  const row = {
    Id: 'e'.repeat(64),
    Names: ['openshell-supervisor-sandbox-1'],
    Labels: {
      'openshell.ai/sandbox-id': receipt.id,
      'openshell.ai/sandbox-name': receipt.name,
      'openshell.ai/sandbox-workspace': 'work',
      'openshell.ai/sandbox-namespace': 'default',
      'openshell.ai/isolation-role': 'supervisor',
      'openshell.managed': 'true',
    },
  };
  const input = {
    receipt,
    workspace: 'work',
    namespace: 'default',
    supervisorImage: image,
    assertCurrent: vi.fn(async () => {}),
    gatewayInventory: vi.fn(async () => [gatewayRow]),
    inventory: vi.fn(async () => [row]),
    imageId: vi.fn(async () => image),
    loggingFilter: vi.fn(async () => 'L'),
    readConsole: vi.fn(
      async () =>
        `2026-10-09T00:00:00.000Z DEBUG openshell.routing_http: routing diagnostic v1 kind=account_check method=GET outcome=response request_ordinal=1 status_code=403`,
    ),
  };
  return { input, row, gatewayRow };
}
it('reads only exact claimed supervisor ID and rechecks custody/container/image around capture', async () => {
  const f = fixture();
  const result = await captureRoutingConsole(f.input);
  expect(result.observations[0].statusCode).toBe(403);
  expect(f.input.readConsole).toHaveBeenCalledExactlyOnceWith(f.row.Id);
  expect(f.input.inventory).toHaveBeenCalledTimes(2);
  expect(f.input.gatewayInventory).toHaveBeenCalledTimes(2);
  expect(f.input.imageId).toHaveBeenCalledTimes(2);
  expect(f.input.assertCurrent).toHaveBeenCalledTimes(18);
});
it.each(['namespace', 'workspace', 'role', 'id', 'name', 'image', 'ambiguous'] as const)(
  'refuses %s drift before reading console',
  async (kind) => {
    const f = fixture();
    if (kind === 'image') f.input.imageId = vi.fn(async () => `sha256:${'f'.repeat(64)}`);
    else if (kind === 'ambiguous')
      f.input.inventory = vi.fn(async () => [f.row, { ...f.row, Id: 'f'.repeat(64) }]);
    else {
      const keys = {
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
it.each(['id', 'name', 'workspace', 'claim', 'discovery', 'duplicate', 'missing'] as const)(
  'requires the exact gateway claim binding before reading console (%s)',
  async (kind) => {
    const f = fixture();
    // Even custom physical labels cannot replace the gateway metadata proof.
    Object.assign(f.row.Labels, f.gatewayRow.labels);
    if (kind === 'duplicate')
      f.input.gatewayInventory.mockResolvedValue([f.gatewayRow, { ...f.gatewayRow }]);
    else if (kind === 'missing') f.input.gatewayInventory.mockResolvedValue([]);
    else if (kind === 'claim' || kind === 'discovery')
      f.gatewayRow.labels[kind === 'claim' ? 'mitzo.discovery.claim' : 'mitzo.discovery'] =
        'changed';
    else f.gatewayRow[kind] = 'changed';
    await expect(captureRoutingConsole(f.input)).rejects.toThrow();
    expect(f.input.readConsole).not.toHaveBeenCalled();
    expect(f.input.inventory).not.toHaveBeenCalled();
  },
);
it.each(['id', 'name', 'workspace', 'claim', 'duplicate'] as const)(
  'discards read console when the gateway binding drifts (%s)',
  async (kind) => {
    const f = fixture();
    const changed = structuredClone(f.gatewayRow);
    if (kind === 'claim') changed.labels['mitzo.discovery.claim'] = 'changed';
    else if (kind !== 'duplicate') changed[kind] = 'changed';
    f.input.gatewayInventory
      .mockResolvedValueOnce([f.gatewayRow])
      .mockResolvedValueOnce(kind === 'duplicate' ? [changed, { ...changed }] : [changed]);
    await expect(captureRoutingConsole(f.input)).rejects.toThrow();
    expect(f.input.readConsole).toHaveBeenCalledOnce();
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
it('binds selected OCI config identity when container manifest digest differs', async () => {
  const f = fixture();
  f.input.imageId.mockResolvedValue('d'.repeat(64));
  expect((await captureRoutingConsole(f.input)).availability).toBe('captured');
  f.input.imageId.mockResolvedValue(`sha256:${'f'.repeat(64)}`);
  await expect(captureRoutingConsole(f.input)).rejects.toThrow('image changed');
});

it.each(['missing', 'false', 'legacy-key-only'] as const)(
  'refuses a supervisor without the actual native managed proof (%s)',
  async (kind) => {
    const f = fixture();
    const labels = f.row.Labels as Record<string, string>;
    if (kind === 'false') labels['openshell.managed'] = 'false';
    else delete labels['openshell.managed'];
    if (kind === 'legacy-key-only') labels['openshell.ai/managed'] = 'true';
    await expect(captureRoutingConsole(f.input)).rejects.toThrow('identity changed');
    expect(f.input.readConsole).not.toHaveBeenCalled();
  },
);
