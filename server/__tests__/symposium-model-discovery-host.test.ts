import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFile, spawn } from 'node:child_process';
import { runSymposiumModelDiscovery } from '../symposium-model-discovery.js';
import { guardDiscoveryOperations } from '../symposium-discovery-custody.js';
import { createDiscoveryHostOperations } from '../symposium-model-discovery-host.js';
vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
let root: string;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  vi.resetAllMocks();
});
function fixture() {
  root = mkdtempSync(join(tmpdir(), 'discovery-mock-'));
  const environment = {
    PATH: '/usr/bin:/bin',
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache'),
  };
  Object.entries(environment)
    .filter(([key]) => key !== 'PATH')
    .forEach(([, path]) => mkdirSync(path, { mode: 0o700 }));
  const digest = createHash('sha256').update('fixture').digest('hex');
  for (const name of ['cli', 'policy', 'config-pin'])
    writeFileSync(join(root, name), 'fixture', { mode: 0o600 });
  const config = {
    cliSha256: digest,
    workloadImage: `sha256:${'a'.repeat(64)}`,
    policySha256: digest,
    podmanUrl: 'unix:///private/mock-podman.sock',
    gateway: 'owned',
    workspace: 'work',
    provider: { name: 'personal', id: 'provider-1' },
  };
  const options = {
    cli: join(root, 'cli'),
    podman: '/usr/bin/podman',
    policy: join(root, 'policy'),
    journal: join(root, 'journal.json'),
    namespace: 'default',
    environment,
    configPins: [{ path: join(root, 'config-pin'), sha256: digest, mode: 0o600 }],
    attestGateway: vi.fn(async () => {}),
  };
  return { config, options };
}
it('fails closed when pinned bytes change, without invoking management', async () => {
  const { config, options } = fixture();
  const ops = createDiscoveryHostOperations(config, options);
  writeFileSync(options.policy, 'changed');
  await expect(ops.verifyCustody(config)).rejects.toThrow('Discovery pin changed');
  expect(execFile).not.toHaveBeenCalled();
});
it('rejects inherited authentication environment and keeps journals exclusive/private', async () => {
  const { config, options } = fixture();
  expect(() =>
    createDiscoveryHostOperations(config, {
      ...options,
      environment: { ...options.environment, OPENAI_API_KEY: 'fixture' },
    }),
  ).toThrow('Private management environment');
  const ops = createDiscoveryHostOperations(config, options);
  await ops.verifyCustody(config);
  const receipt = {
    name: `md-${'a'.repeat(16)}`,
    claim: 'b'.repeat(64),
    configHash: 'c'.repeat(64),
  };
  await ops.persistReceipt(receipt, true);
  await expect(ops.persistReceipt(receipt, true)).rejects.toThrow();
  expect(await ops.readReceipt()).toEqual(receipt);
  expect(options.attestGateway).toHaveBeenCalledOnce();
});

it('uses only the explicit Podman endpoint and private environment for physical absence', async () => {
  const { config, options } = fixture();
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    (args[3] as (error: null, stdout: string) => void)(null, '[]');
  }) as typeof execFile);
  const ops = createDiscoveryHostOperations(config, options);
  expect(
    await ops.physicalAbsent({
      name: `md-${'a'.repeat(16)}`,
      claim: 'b'.repeat(64),
      configHash: 'c'.repeat(64),
      id: 'sandbox-1',
    }),
  ).toBe(true);
  expect(execFile).toHaveBeenCalledWith(
    options.podman,
    ['--url', config.podmanUrl, 'ps', '--all', '--format', 'json'],
    expect.objectContaining({ env: options.environment }),
    expect.any(Function),
  );
});
it('keeps physical cleanup incomplete for a supervisor identified by the exact sandbox ID', async () => {
  const { config, options } = fixture();
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    (args[3] as (error: null, stdout: string) => void)(
      null,
      JSON.stringify([{ Names: ['supervisor-sandbox-1'], Labels: {} }]),
    );
  }) as typeof execFile);
  const ops = createDiscoveryHostOperations(config, options);
  expect(
    await ops.physicalAbsent({
      name: `md-${'a'.repeat(16)}`,
      claim: 'b'.repeat(64),
      configHash: 'c'.repeat(64),
      id: 'sandbox-1',
    }),
  ).toBe(false);
});

it('creates the reviewed controller workspace rather than an unrelated discovery directory', async () => {
  const { config, options } = fixture();
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    (args[3] as (error: null, stdout: string) => void)(null, '{}');
  }) as typeof execFile);
  const ops = createDiscoveryHostOperations(config, options);
  await ops.create(
    { name: `md-${'a'.repeat(16)}`, claim: 'b'.repeat(64), configHash: 'c'.repeat(64) },
    config,
  );
  const args = vi.mocked(execFile).mock.calls[0][1] as string[];
  expect(args.at(-1)).toBe('mkdir -p /sandbox/workspaces/mgmt && exec sleep infinity');
  expect(args).toContain('--no-auto-providers');
});

const inventories = [
  ['sandboxes', 'list'],
  ['providers', 'providerInventory'],
  ['providers', 'attachedProviders'],
] as const;
const inventoryReceipt = {
  name: 'md-aaaaaaaaaaaaaaaa',
  claim: 'b'.repeat(64),
  configHash: 'c'.repeat(64),
};
for (const [key, method] of inventories) {
  it(`${method} consumes every unique page before returning inventory`, async () => {
    const { config, options } = fixture();
    const pages = [
      { [key]: [{ id: 'first' }], next_page_token: 'next' },
      { [key]: [{ id: 'second' }], next_page_token: '' },
    ];
    vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
      (args[3] as (error: null, stdout: string) => void)(null, JSON.stringify(pages.shift()));
    }) as typeof execFile);
    const ops = createDiscoveryHostOperations(config, options);
    expect(await ops[method](inventoryReceipt)).toEqual([{ id: 'first' }, { id: 'second' }]);
    expect(vi.mocked(execFile).mock.calls[1][1]).toEqual(
      expect.arrayContaining(['--page-size', '100', '--page-token', 'next']),
    );
  });
  it.each([{ page: [] }, { page: { [key]: [] } }, { page: { [key]: [], next_page_token: null } }])(
    `${method} rejects missing completion evidence %j`,
    async ({ page }) => {
      const { config, options } = fixture();
      vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
        (args[3] as (error: null, stdout: string) => void)(null, JSON.stringify(page));
      }) as typeof execFile);
      await expect(
        createDiscoveryHostOperations(config, options)[method](inventoryReceipt),
      ).rejects.toThrow('inventory');
    },
  );
  it(`${method} rejects repeated continuation tokens without returning partial rows`, async () => {
    const { config, options } = fixture();
    vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
      (args[3] as (error: null, stdout: string) => void)(
        null,
        JSON.stringify({ [key]: [{ id: 'partial' }], next_page_token: 'same' }),
      );
    }) as typeof execFile);
    await expect(
      createDiscoveryHostOperations(config, options)[method](inventoryReceipt),
    ).rejects.toThrow('inventory');
    expect(execFile).toHaveBeenCalledTimes(2);
  });
}

it('bounds unique continuation pages without accepting a partial inventory', async () => {
  const { config, options } = fixture();
  let page = 0;
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    (args[3] as (error: null, stdout: string) => void)(
      null,
      JSON.stringify({ sandboxes: [], next_page_token: `page-${++page}` }),
    );
  }) as typeof execFile);
  await expect(createDiscoveryHostOperations(config, options).list()).rejects.toThrow('page limit');
  expect(execFile).toHaveBeenCalledTimes(100);
});

it('exclusively owns the journal across separate host adapters until the active attempt exits', async () => {
  const { config, options } = fixture();
  const first = createDiscoveryHostOperations(config, options);
  const second = createDiscoveryHostOperations(config, options);
  let release!: () => void;
  let acquired!: () => void;
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const active = first.withExclusiveAttempt(async () => {
    acquired();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await ready;
  const forbidden = vi.fn();
  await expect(second.withExclusiveAttempt(forbidden)).rejects.toThrow();
  expect(forbidden).not.toHaveBeenCalled();
  release();
  await active;
  await second.withExclusiveAttempt(async () => {});
});

it('terminates the detached SSH process group including its proxy child', async () => {
  const { config, options } = fixture();
  const child = Object.assign(new EventEmitter(), {
    pid: 987654,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(child as never);
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  try {
    const client = await createDiscoveryHostOperations(config, options).openClient(
      inventoryReceipt,
    );
    client.close();
    expect(spawn).toHaveBeenCalledWith(
      'ssh',
      expect.any(Array),
      expect.objectContaining({ detached: true, shell: false }),
    );
    expect(kill).toHaveBeenCalledWith(-987654, 'SIGTERM');
  } finally {
    kill.mockRestore();
  }
});

it('preserves supported dotted gateway/workspace names in the private SSH process spec', async () => {
  const { config, options } = fixture();
  config.gateway = 'owned.gateway';
  config.workspace = 'owned.workspace';
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  vi.mocked(spawn).mockReturnValue(child as never);
  const client = await createDiscoveryHostOperations(config, options).openClient(inventoryReceipt);
  client.close();
  expect(spawn).toHaveBeenCalledWith(
    'ssh',
    expect.arrayContaining([
      `ProxyCommand=${options.cli} ssh-proxy --gateway-name owned.gateway --name ${inventoryReceipt.name} --workspace owned.workspace`,
    ]),
    expect.any(Object),
  );
});

it('syncs the creation receipt and directory before releasing persistence to the caller', async () => {
  const { config, options } = fixture();
  const events: string[] = [];
  vi.mocked(open)
    .mockResolvedValueOnce({
      writeFile: async () => {
        events.push('write');
      },
      sync: async () => {
        events.push('file-sync');
      },
      close: async () => {
        events.push('file-close');
      },
    } as never)
    .mockResolvedValueOnce({
      sync: async () => {
        events.push('directory-sync');
      },
      close: async () => {
        events.push('directory-close');
      },
    } as never);
  await createDiscoveryHostOperations(config, options).persistReceipt(inventoryReceipt, true);
  expect(events).toEqual(['write', 'file-sync', 'file-close', 'directory-sync', 'directory-close']);
});
it('terminates the cancellation SSH proxy process group when execFile times out', async () => {
  const { config, options } = fixture();
  const child = { pid: 987653, kill: vi.fn() };
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    setTimeout(() => {
      child.kill();
      (args[3] as (error: Error, stdout: string) => void)(new Error('timeout'), '');
    }, 0);
    return child;
  }) as unknown as typeof execFile);
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  try {
    await expect(
      createDiscoveryHostOperations(config, options).cancel(inventoryReceipt),
    ).rejects.toThrow('failed');
    expect(execFile).toHaveBeenCalledWith(
      'ssh',
      expect.any(Array),
      expect.objectContaining({ detached: true, shell: false }),
      expect.any(Function),
    );
    expect(kill).toHaveBeenCalledWith(-987653, 'SIGTERM');
  } finally {
    kill.mockRestore();
  }
});

it('marks external creation immediately before dispatch, after host preflight', async () => {
  const { config, options } = fixture();
  const order: string[] = [];
  options.attestGateway.mockImplementation(async () => {
    order.push('custody');
  });
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    order.push('dispatch');
    (args[3] as (error: null, stdout: string) => void)(null, '{}');
  }) as typeof execFile);
  const ops = createDiscoveryHostOperations(config, options);
  await ops.create(inventoryReceipt, config, () => {
    order.push('mark');
  });
  expect(order).toEqual(['custody', 'mark', 'dispatch', 'custody']);
  options.attestGateway.mockRejectedValue(new Error('preflight'));
  const mark = vi.fn();
  await expect(ops.create(inventoryReceipt, config, mark)).rejects.toThrow('preflight');
  expect(mark).not.toHaveBeenCalled();
});

it.each([false, true])(
  'cleans only its undispatched private journal after custody loss, replacement=%s',
  async (replaced) => {
    const { config, options } = fixture();
    const base = createDiscoveryHostOperations(config, options);
    let current = true;
    const persist = base.persistReceipt;
    base.persistReceipt = async (receipt, exclusive) => {
      await persist(receipt, exclusive);
      if (replaced)
        writeFileSync(options.journal, JSON.stringify({ ...receipt, claim: 'f'.repeat(64) }));
      current = false;
    };
    const guarded = guardDiscoveryOperations(
      base,
      () => {
        if (!current) throw new Error('custody changed');
      },
      { email: 'a@example.test', planType: 'plus' },
    );
    await runSymposiumModelDiscovery(config, guarded);
    expect(!!(await base.readReceipt())).toBe(replaced);
    expect(execFile).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  },
);

it('rejects local undispatched cleanup outside its lock and after actual create dispatch', async () => {
  const { config, options } = fixture();
  const ops = createDiscoveryHostOperations(config, options);
  const receipt = {
    name: 'md-aaaaaaaaaaaaaaaa',
    claim: 'b'.repeat(64),
    configHash: 'c'.repeat(64),
  };
  await ops.persistReceipt(receipt, true);
  await expect(ops.clearUndispatchedReceipt!(receipt)).rejects.toThrow('proof');
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    (args[3] as (error: null, stdout: string) => void)(null, '{}');
  }) as typeof execFile);
  await ops.withExclusiveAttempt(async () => {
    await ops.create(receipt, config);
    await expect(ops.clearUndispatchedReceipt!(receipt)).rejects.toThrow('proof');
  });
  expect(await ops.readReceipt()).toEqual(receipt);
});
it.each(['name', 'claim', 'configHash'])(
  'rejects a different undispatched journal %s under the lock',
  async (field) => {
    const { config, options } = fixture();
    const ops = createDiscoveryHostOperations(config, options);
    const receipt = {
      name: 'md-aaaaaaaaaaaaaaaa',
      claim: 'b'.repeat(64),
      configHash: 'c'.repeat(64),
    };
    await ops.withExclusiveAttempt(async () => {
      await ops.persistReceipt(receipt, true);
      await expect(
        ops.clearUndispatchedReceipt!({ ...receipt, [field]: 'different' }),
      ).rejects.toThrow('identity');
      expect(await ops.readReceipt()).toEqual(receipt);
    });
  },
);

it('clears a completed journal only when the exact identity remains under its lock', async () => {
  const { config, options } = fixture();
  const ops = createDiscoveryHostOperations(config, options);
  const receipt = {
    name: 'md-aaaaaaaaaaaaaaaa',
    claim: 'b'.repeat(64),
    configHash: 'c'.repeat(64),
    id: 'created-sandbox',
  };
  await ops.persistReceipt(receipt, true);
  await expect(ops.clearReceipt(receipt)).rejects.toThrow('proof');
  await ops.withExclusiveAttempt(async () => {
    const replacement = { ...receipt, claim: 'd'.repeat(64) };
    writeFileSync(options.journal, JSON.stringify(replacement));
    await expect(ops.clearReceipt(receipt)).rejects.toThrow('identity');
    expect(await ops.readReceipt()).toEqual(replacement);
    writeFileSync(options.journal, JSON.stringify(receipt));
    await ops.clearReceipt(receipt);
    expect(await ops.readReceipt()).toBeUndefined();
  });
});
