import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  createDiscoveryOwnedReadyEvidence,
  createSymposiumModelDiscoveryRecovery,
  type DiscoveryOperations,
  discoveryClaimLabel,
  type DiscoveryConfig,
  type DiscoveryPhysicalCleanupEvidence,
} from '../symposium-model-discovery.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SymposiumWorkspaceLifecycle } from '../symposium-workspace-lifecycle.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'workspace-fence-'));
  roots.push(root);
  const path = join(root, 'fence.json');
  return { path, fence: new SymposiumWorkspaceLifecycle(path, () => {}) };
}
it('holds cleanup until an invisible in-flight sandbox create has completed', async () => {
  const { fence } = fixture();
  let finish!: () => void;
  const deletion = vi.fn(async () => {});
  const create = fence.create(
    () => {},
    (markDispatched) => {
      markDispatched();
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  );
  await Promise.resolve();
  const cleanup = fence.cleanup(deletion);
  await Promise.resolve();
  expect(deletion).not.toHaveBeenCalled();
  finish();
  await create;
  await cleanup;
  expect(deletion).toHaveBeenCalledOnce();
});
it('retains uncertainty across restart when create rejects or remains in flight', async () => {
  const { fence, path } = fixture();
  let fail!: (error: Error) => void;
  const create = fence.create(
    () => {},
    (markDispatched) => {
      markDispatched();
      return new Promise<void>((_, reject) => {
        fail = reject;
      });
    },
  );
  await Promise.resolve();
  const restored = new SymposiumWorkspaceLifecycle(path, () => {});
  await expect(restored.cleanup(async () => {})).rejects.toThrow('recovery');
  fail(new Error('unknown create outcome'));
  await expect(create).rejects.toThrow();
  await expect(fence.cleanup(async () => {})).rejects.toThrow('recovery');
});
it('revalidates queued creation after cleanup fences an account, without issuing create', async () => {
  const { fence } = fixture();
  let authorized = true;
  let finish!: () => void;
  const cleanup = fence.cleanup(
    () =>
      new Promise<void>((resolve) => {
        authorized = false;
        finish = resolve;
      }),
  );
  await Promise.resolve();
  const createOperation = vi.fn(async () => {});
  const create = fence.create(() => {
    if (!authorized) throw new Error('revoked');
  }, createOperation);
  finish();
  await cleanup;
  await expect(create).rejects.toThrow('revoked');
  expect(createOperation).not.toHaveBeenCalled();
  await expect(fence.cleanup(async () => {})).resolves.toBeUndefined();
});
it('does not quarantine preflight failures before explicit external dispatch', async () => {
  const { fence, path } = fixture();
  await expect(
    fence.create(
      () => {},
      async () => {
        throw new Error('provider read unavailable');
      },
    ),
  ).rejects.toThrow('provider read');
  await expect(fence.cleanup(async () => {})).resolves.toBeUndefined();
  await expect(
    new SymposiumWorkspaceLifecycle(path, () => {}).cleanup(async () => {}),
  ).resolves.toBeUndefined();
});
it('refuses a successful create result without its trusted dispatch marker', async () => {
  const { fence } = fixture();
  await expect(
    fence.create(
      () => {},
      async () => 'unproven',
    ),
  ).rejects.toThrow('dispatch was not recorded');
  await expect(fence.cleanup(async () => {})).resolves.toBeUndefined();
});

it('fences queued creates and waits for an already dispatched create before draining', async () => {
  const { fence } = fixture();
  let release!: () => void;
  const first = fence.create(
    () => {},
    async (mark) => {
      mark();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  );
  await Promise.resolve();
  const queuedOperation = vi.fn(async () => {});
  const queued = expect(fence.create(() => {}, queuedOperation)).rejects.toThrow('shutting down');
  let drained = false;
  fence.beginDrain();
  const drain = fence.drain(new AbortController().signal).then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  release();
  await first;
  await queued;
  await drain;
  expect(queuedOperation).not.toHaveBeenCalled();
  await expect(fence.create(() => {}, queuedOperation)).rejects.toThrow('shutting down');
  await expect(fence.cleanup(async () => {})).resolves.toBeUndefined();
});
it('allows cleanup after a persisted terminal receipt even when later configuration fails', async () => {
  const { fence } = fixture();
  await expect(
    fence.create(
      () => {},
      async (dispatched, settled) => {
        dispatched();
        settled!();
        throw new Error('upload failed');
      },
    ),
  ).rejects.toThrow('upload failed');
  await expect(fence.cleanup(async () => 'cleanup permitted')).resolves.toBe('cleanup permitted');
});
it('retains uncertainty if custody changes before terminal receipt settlement', async () => {
  const { path } = fixture();
  let current = true;
  const fence = new SymposiumWorkspaceLifecycle(path, () => {
    if (!current) throw new Error('custody lost');
  });
  await expect(
    fence.create(
      () => {},
      async (dispatched, settled) => {
        dispatched();
        current = false;
        settled!();
      },
    ),
  ).rejects.toThrow('custody lost');
  current = true;
  await expect(fence.cleanup(async () => {})).rejects.toThrow('recovery');
});
it('quiesces controller work without permanently shutting down retained creation custody', async () => {
  const { fence } = fixture();
  fence.pauseController();
  const physical = vi.fn(async (dispatch: () => void) => {
    dispatch();
  });
  await expect(fence.create(() => {}, physical)).rejects.toThrow('controller');
  expect(physical).not.toHaveBeenCalled();
  await fence.quiesceController(new AbortController().signal);
  await fence.cleanup(async () => {});
  fence.resumeController();
  await expect(fence.create(() => {}, physical)).resolves.toBeUndefined();
  expect(physical).toHaveBeenCalledOnce();
  fence.beginDrain();
  expect(() => fence.resumeController()).toThrow('shutting down');
});
it('does not let a replacement controller clear an uncertain dispatched creation', async () => {
  const { fence } = fixture();
  await expect(
    fence.create(
      () => {},
      async (dispatch) => {
        dispatch();
        throw Error('lost receipt');
      },
    ),
  ).rejects.toThrow('lost receipt');
  fence.pauseController();
  await expect(fence.quiesceController(new AbortController().signal)).rejects.toThrow('recovery');
  expect(() => fence.resumeController()).toThrow('recovery');
});

function discoveryEvidence() {
  const config: DiscoveryConfig = {
    cliSha256: 'a'.repeat(64),
    workloadImage: 'sha256:' + 'b'.repeat(64),
    policySha256: 'c'.repeat(64),
    podmanUrl: 'unix:///mock.sock',
    gateway: 'owned-gateway',
    workspace: 'owned-workspace',
    provider: { name: 'personal', id: 'provider-id' },
  };
  const receipt = {
    id: 'original-native-id',
    name: 'md-' + 'a'.repeat(16),
    claim: 'b'.repeat(64),
    configHash: createHash('sha256').update(JSON.stringify(config)).digest('hex'),
  };
  const ready = createDiscoveryOwnedReadyEvidence(config, receipt, {
    ...receipt,
    workspace: config.workspace,
    phase: 'Ready',
    labels: {
      'mitzo.discovery': 'models',
      'mitzo.discovery.claim': discoveryClaimLabel(receipt.claim),
    },
  });
  return { config, receipt, ready };
}
function readyEvidence() {
  return discoveryEvidence().ready;
}
function bind(
  scope: ReturnType<SymposiumWorkspaceLifecycle['retainDiscoveryCreation']>,
  evidence = discoveryEvidence(),
) {
  const { name, claim, configHash } = evidence.receipt;
  scope.bindReceipt({ name, claim, configHash });
}
async function physicalCleanup(fixture = discoveryEvidence()) {
  const recovery = createSymposiumModelDiscoveryRecovery(
    fixture.config,
    fixture.receipt,
    fixture.ready,
  );
  const operations = {
    withExclusiveAttempt: async (run: () => Promise<unknown>) => run(),
    verifyCustody: async () => {},
    readReceipt: async () => fixture.receipt,
    list: async () => [],
    physicalAbsent: async () => true,
    clearReceipt: async () => {},
  } as unknown as DiscoveryOperations;
  expect((await recovery(operations)).status).toBe('reconciled');
  return recovery.physicalCleanupEvidence()!;
}
it('keeps ordinary work and foreign or reopened scopes closed after original dispatch uncertainty', async () => {
  const { fence, path } = fixture();
  const scope = fence.retainDiscoveryCreation();
  await expect(
    scope.create(
      () => {},
      async (dispatch) => {
        bind(scope);
        dispatch();
        scope.retainReady(readyEvidence());
        throw Error('original ID write lost');
      },
    ),
  ).rejects.toThrow('ID write lost');
  expect(JSON.parse(readFileSync(path, 'utf8')).uncertain).toBe(true);
  const unused = vi.fn(async () => ({ result: 'unproven' }));
  await expect(fence.cleanup(async () => {})).rejects.toThrow('recovery');
  await expect(
    fence.create(
      () => {},
      async () => {},
    ),
  ).rejects.toThrow('recovery');
  await expect(fence.drain(new AbortController().signal)).rejects.toThrow('recovery');
  await expect(fence.retainDiscoveryCreation().recover(unused)).rejects.toThrow(
    'original host recovery',
  );
  const reopened = new SymposiumWorkspaceLifecycle(path, () => {});
  await expect(reopened.retainDiscoveryCreation().recover(unused)).rejects.toThrow(
    'original host recovery',
  );
  expect(unused).not.toHaveBeenCalled();
  await expect(scope.recover(unused)).rejects.toThrow('physical cleanup unconfirmed');
  await expect(
    scope.recover(async () => ({
      result: 'unproven',
      physicalCleanup: {} as DiscoveryPhysicalCleanupEvidence,
    })),
  ).rejects.toThrow();
  expect(JSON.parse(readFileSync(path, 'utf8')).uncertain).toBe(true);
  await expect(fence.cleanup(async () => {})).rejects.toThrow('recovery');
});
it('retains original uncertainty when fresh custody is lost or original recovery throws', async () => {
  const { path } = fixture();
  let current = true;
  const fence = new SymposiumWorkspaceLifecycle(path, () => {
    if (!current) throw Error('custody lost');
  });
  const scope = fence.retainDiscoveryCreation();
  await expect(
    scope.create(
      () => {},
      async (dispatch) => {
        bind(scope);
        dispatch();
        scope.retainReady(readyEvidence());
        throw Error('ID write lost');
      },
    ),
  ).rejects.toThrow('ID write lost');
  const cleanup = vi.fn(async () => ({ result: undefined }));
  current = false;
  await expect(scope.recover(cleanup)).rejects.toThrow('custody lost');
  expect(cleanup).not.toHaveBeenCalled();
  current = true;
  await expect(
    scope.recover(async () => {
      throw Error('physical cleanup uncertain');
    }),
  ).rejects.toThrow('physical cleanup uncertain');
  expect(JSON.parse(readFileSync(path, 'utf8')).uncertain).toBe(true);
});
it('rejects forged Ready evidence and reusing the original creation scope', async () => {
  const { fence } = fixture();
  const scope = fence.retainDiscoveryCreation();
  await expect(
    scope.create(
      () => {},
      async (dispatch) => {
        bind(scope);
        dispatch();
        scope.retainReady({ receipt: readyEvidence().receipt });
      },
    ),
  ).rejects.toThrow();
  await expect(
    scope.create(
      () => {},
      async () => {},
    ),
  ).rejects.toThrow('already used');
  const cleanup = vi.fn(async () => ({ result: undefined }));
  await expect(scope.recover(cleanup)).rejects.toThrow('physical cleanup unconfirmed');
  expect(cleanup).toHaveBeenCalledOnce();
});

it('settles only its original creation after positive core cleanup and prevents stale scope clearing another dispatch', async () => {
  const { fence, path } = fixture();
  const evidence = discoveryEvidence();
  const original = fence.retainDiscoveryCreation();
  await expect(
    original.create(
      () => {},
      async (dispatch) => {
        bind(original, evidence);
        dispatch();
        original.retainReady(evidence.ready);
        throw Error('first-ID write lost');
      },
    ),
  ).rejects.toThrow('write lost');
  await expect(
    original.recover(async () => ({
      result: 'reconciled',
      physicalCleanup: await physicalCleanup(evidence),
    })),
  ).resolves.toBe('reconciled');
  expect(JSON.parse(readFileSync(path, 'utf8')).uncertain).toBe(false);
  await expect(fence.cleanup(async () => 'ordinary')).resolves.toBe('ordinary');
  await expect(
    fence.create(
      () => {},
      async (dispatch) => {
        dispatch();
        throw Error('another unknown create');
      },
    ),
  ).rejects.toThrow('unknown create');
  const operation = vi.fn(async () => ({
    result: undefined,
    physicalCleanup: await physicalCleanup(evidence),
  }));
  await expect(original.recover(operation)).rejects.toThrow('original host recovery');
  expect(operation).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(path, 'utf8')).uncertain).toBe(true);
});
it('rejects genuine cleanup evidence belonging to another original native identity', async () => {
  const { fence, path } = fixture();
  const original = fence.retainDiscoveryCreation();
  await expect(
    original.create(
      () => {},
      async (dispatch) => {
        bind(original);
        dispatch();
        original.retainReady(readyEvidence());
        throw Error('unknown');
      },
    ),
  ).rejects.toThrow('unknown');
  const foreign = discoveryEvidence();
  foreign.receipt.id = 'foreign-id';
  foreign.ready = createDiscoveryOwnedReadyEvidence(foreign.config, foreign.receipt, {
    ...foreign.receipt,
    workspace: foreign.config.workspace,
    phase: 'Ready',
    labels: {
      'mitzo.discovery': 'models',
      'mitzo.discovery.claim': discoveryClaimLabel(foreign.receipt.claim),
    },
  });
  await expect(
    original.recover(async () => ({
      result: 'unproven',
      physicalCleanup: await physicalCleanup(foreign),
    })),
  ).rejects.toThrow();
  expect(JSON.parse(readFileSync(path, 'utf8')).uncertain).toBe(true);
});

it.each(['original', 'forged', 'other-claim', 'other-config'] as const)(
  'settles a non-Ready original dispatch only with its positive core cleanup proof (%s)',
  async (kind) => {
    const { fence, path } = fixture();
    const evidence = discoveryEvidence();
    const original = fence.retainDiscoveryCreation();
    await expect(
      original.create(
        () => {},
        async (dispatch) => {
          bind(original, evidence);
          dispatch();
          throw Error('never Ready');
        },
      ),
    ).rejects.toThrow('never Ready');
    const foreign = discoveryEvidence();
    if (kind === 'other-claim') foreign.receipt.claim = 'd'.repeat(64);
    if (kind === 'other-config') {
      foreign.config.provider.id = 'other-provider';
      foreign.receipt.configHash = createHash('sha256')
        .update(JSON.stringify(foreign.config))
        .digest('hex');
    }
    foreign.ready = createDiscoveryOwnedReadyEvidence(foreign.config, foreign.receipt, {
      ...foreign.receipt,
      workspace: foreign.config.workspace,
      phase: 'Ready',
      labels: {
        'mitzo.discovery': 'models',
        'mitzo.discovery.claim': discoveryClaimLabel(foreign.receipt.claim),
      },
    });
    const proof = await physicalCleanup(foreign);
    const cleanup = kind === 'forged' ? structuredClone(proof) : proof;
    const operation = vi.fn(async () => ({ result: 'reconciled', physicalCleanup: cleanup }));
    const reopened = new SymposiumWorkspaceLifecycle(path, () => {});
    await expect(fence.retainDiscoveryCreation().recover(operation)).rejects.toThrow(
      'original host recovery',
    );
    await expect(reopened.retainDiscoveryCreation().recover(operation)).rejects.toThrow(
      'original host recovery',
    );
    expect(operation).not.toHaveBeenCalled();
    if (kind === 'original') await expect(original.recover(operation)).resolves.toBe('reconciled');
    else await expect(original.recover(operation)).rejects.toThrow('Physical cleanup evidence');
    expect(JSON.parse(readFileSync(path, 'utf8')).uncertain).toBe(kind !== 'original');
  },
);

it('refuses recovery when the original dispatch recording failed before native allocation', async () => {
  const { fence, path } = fixture();
  mkdirSync(path);
  const original = fence.retainDiscoveryCreation();
  const evidence = discoveryEvidence();
  await expect(
    original.create(
      () => {},
      async (dispatch) => {
        bind(original, evidence);
        dispatch();
      },
    ),
  ).rejects.toThrow();
  const cleanup = vi.fn(async () => ({
    result: 'unproven',
    physicalCleanup: await physicalCleanup(evidence),
  }));
  await expect(original.recover(cleanup)).rejects.toThrow('original host recovery');
  expect(cleanup).not.toHaveBeenCalled();
});

it.each(['original', 'inactive', 'foreign-scope', 'reopened', 'forged'] as const)(
  'authorizes a pending journal only inside its active original recovery scope (%s)',
  async (kind) => {
    const { fence, path } = fixture();
    const evidence = discoveryEvidence();
    const scope = fence.retainDiscoveryCreation();
    await expect(
      scope.create(
        () => {},
        async (dispatch) => {
          bind(scope, evidence);
          dispatch();
          throw Error('first ID write failed');
        },
      ),
    ).rejects.toThrow('first ID write failed');
    const pending = {
      name: evidence.receipt.name,
      claim: evidence.receipt.claim,
      configHash: evidence.receipt.configHash,
    };
    let journal: typeof pending | undefined = pending;
    let exists = true;
    const ops = {
      withExclusiveAttempt: async (run: () => Promise<unknown>) => run(),
      verifyCustody: async () => {},
      readReceipt: async () => journal,
      list: vi.fn(async () =>
        exists
          ? [
              {
                ...evidence.receipt,
                workspace: evidence.config.workspace,
                phase: 'Pending',
                labels: {
                  'mitzo.discovery': 'models',
                  'mitzo.discovery.claim': discoveryClaimLabel(evidence.receipt.claim),
                },
              },
            ]
          : [],
      ),
      persistReceipt: vi.fn(async (value) => {
        journal = value;
      }),
      cancel: vi.fn(async () => {}),
      delete: vi.fn(async () => {
        exists = false;
      }),
      physicalAbsent: async () => !exists,
      wait: async () => {},
      clearReceipt: async () => {
        journal = undefined;
      },
      create: vi.fn(),
      openClient: vi.fn(),
    } as unknown as DiscoveryOperations;
    const authority =
      kind === 'foreign-scope'
        ? fence.retainDiscoveryCreation().pendingRecoveryAuthority
        : kind === 'reopened'
          ? new SymposiumWorkspaceLifecycle(path, () => {}).retainDiscoveryCreation()
              .pendingRecoveryAuthority
          : kind === 'forged'
            ? structuredClone(scope.pendingRecoveryAuthority)
            : scope.pendingRecoveryAuthority;
    const recovery = createSymposiumModelDiscoveryRecovery(
      evidence.config,
      evidence.receipt,
      undefined,
      authority,
    );
    if (kind === 'inactive') expect((await recovery(ops)).status).toBe('reconciliation_required');
    else {
      const operation = () =>
        recovery(ops).then((result) => ({
          result,
          physicalCleanup: recovery.physicalCleanupEvidence(),
        }));
      if (kind === 'original')
        await expect(scope.recover(operation)).resolves.toMatchObject({ status: 'reconciled' });
      else await expect(scope.recover(operation)).rejects.toThrow('physical cleanup unconfirmed');
    }
    if (kind !== 'original') {
      expect(ops.list).not.toHaveBeenCalled();
      expect(ops.persistReceipt).not.toHaveBeenCalled();
      expect(ops.delete).not.toHaveBeenCalled();
    }
    expect(ops.create).not.toHaveBeenCalled();
    expect(ops.openClient).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(path, 'utf8')).uncertain).toBe(kind !== 'original');
  },
);

it('serializes queued ordinary creation behind positive original cleanup without releasing the fence early', async () => {
  const { fence, path } = fixture();
  const evidence = discoveryEvidence(),
    original = fence.retainDiscoveryCreation();
  await expect(
    original.create(
      () => {},
      async (dispatch) => {
        bind(original, evidence);
        dispatch();
        original.retainReady(evidence.ready);
        throw Error('lost first ID write');
      },
    ),
  ).rejects.toThrow('lost first ID');
  let release!: () => void;
  const recovery = original.recover(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { result: 'reconciled', physicalCleanup: await physicalCleanup(evidence) };
  });
  await Promise.resolve();
  const create = vi.fn(async (dispatch: () => void) => {
    dispatch();
  });
  const queued = fence.create(() => {}, create);
  await Promise.resolve();
  expect(create).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(path, 'utf8')).uncertain).toBe(true);
  release();
  await recovery;
  await queued;
  expect(create).toHaveBeenCalledOnce();
  expect(JSON.parse(readFileSync(path, 'utf8')).uncertain).toBe(false);
});
it('keeps durable uncertainty if custody changes after genuine physical cleanup', async () => {
  const { path } = fixture();
  let current = true;
  const fence = new SymposiumWorkspaceLifecycle(path, () => {
    if (!current) throw Error('custody lost');
  });
  const evidence = discoveryEvidence(),
    scope = fence.retainDiscoveryCreation();
  await expect(
    scope.create(
      () => {},
      async (dispatch) => {
        bind(scope);
        dispatch();
        scope.retainReady(evidence.ready);
        throw Error('ID write lost');
      },
    ),
  ).rejects.toThrow('ID write lost');
  await expect(
    scope.recover(async () => {
      const proof = await physicalCleanup(evidence);
      current = false;
      return { result: 'reconciled', physicalCleanup: proof };
    }),
  ).rejects.toThrow('custody lost');
  expect(JSON.parse(readFileSync(path, 'utf8')).uncertain).toBe(true);
});
it('refuses genuine foreign Ready evidence before it can authorize an original creation settlement', async () => {
  const { fence, path } = fixture();
  const original = discoveryEvidence();
  const foreign = discoveryEvidence();
  foreign.receipt.claim = 'd'.repeat(64);
  foreign.ready = createDiscoveryOwnedReadyEvidence(foreign.config, foreign.receipt, {
    ...foreign.receipt,
    workspace: foreign.config.workspace,
    phase: 'Ready',
    labels: {
      'mitzo.discovery': 'models',
      'mitzo.discovery.claim': discoveryClaimLabel(foreign.receipt.claim),
    },
  });
  const scope = fence.retainDiscoveryCreation();
  await expect(
    scope.create(
      () => {},
      async (dispatch) => {
        bind(scope, original);
        dispatch();
        scope.retainReady(foreign.ready);
      },
    ),
  ).rejects.toThrow('Ready identity changed');
  const cleanup = vi.fn(async () => ({
    result: 'foreign-reconciled',
    physicalCleanup: await physicalCleanup(foreign),
  }));
  await expect(scope.recover(cleanup)).rejects.toThrow('Physical cleanup evidence');
  expect(cleanup).toHaveBeenCalledOnce();
  expect(JSON.parse(readFileSync(path, 'utf8')).uncertain).toBe(true);
});
