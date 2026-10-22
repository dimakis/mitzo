import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  enrolled: false,
  runtime: undefined as unknown,
  validate: vi.fn(),
  key: vi.fn(async () => 'existing-key'),
  fence: vi.fn(),
}));
vi.mock('../account-profiles.js', () => ({
  loadAccountProfiles: () => ({
    apiRoutingProfile: (binding: unknown) => {
      state.validate(binding);
      return { credentialRef: { provider: 'keychain', service: 'existing', account: 'work' } };
    },
    isEnrolledOpenAIAccount: () => state.enrolled,
  }),
}));
vi.mock('../credentials.js', () => ({ credentials: { resolve: state.key } }));
vi.mock('../connections-runtime.js', () => ({ getConnectionsRuntime: () => state.runtime }));
vi.mock('../openai-key-controller.js', () => ({ assertOpenAIKeyController: state.fence }));
import { ConnectionsService } from '../connections-service.js';
import { openAIAccountKeyAuthority } from '../openai-account-key-authority.js';
const binding = {
  accountId: 'work',
  accountLabel: 'Work',
  provider: 'openai' as const,
  model: 'gpt-6-luna',
  profileRevision: 'original',
};
const signal = () => new AbortController().signal;
afterEach(() => {
  state.enrolled = false;
  state.runtime = undefined;
  vi.resetAllMocks();
  state.key.mockResolvedValue('existing-key');
});

it('uses the existing configured key without creating another enrollment', async () => {
  await expect(openAIAccountKeyAuthority(binding).resolveKey('work', signal())).resolves.toBe(
    'existing-key',
  );
  expect(state.key).toHaveBeenCalledWith({
    provider: 'keychain',
    service: 'existing',
    account: 'work',
  });
  expect(state.fence).toHaveBeenCalledWith(
    'work',
    expect.any(String),
    false,
    expect.objectContaining({ credentialBinding: expect.any(String) }),
  );
});
it('selects controller-fenced host custody while preserving sandbox readiness for gateway consumers', async () => {
  const resolveHostKey = vi.fn(async () => 'host-key');
  const resolveKey = vi.fn(async () => {
    throw Error('sandbox unavailable');
  });
  const ready = vi.fn(async () => {
    throw Error('sandbox unavailable');
  });
  state.runtime = {
    openAIKeys: { manages: () => true, resolveHostKey, resolveKey },
    assertOpenAIKeyReady: ready,
  };
  const host = openAIAccountKeyAuthority(binding, undefined, { consumer: 'host' });
  await host.assertReady(signal());
  expect(await host.resolveKey('work', signal())).toBe('host-key');
  expect(resolveHostKey).toHaveBeenCalledTimes(2);
  expect(resolveKey).not.toHaveBeenCalled();
  expect(ready).not.toHaveBeenCalled();
  await expect(openAIAccountKeyAuthority(binding).resolveKey('work', signal())).rejects.toThrow(
    'sandbox unavailable',
  );
});
it('checks existing gateway custody without resolving or copying a host key', async () => {
  let gated = false;
  const ready = vi.fn(async (_id: string, _signal: AbortSignal) => {
    expect(gated).toBe(true);
  });
  state.runtime = {
    assertOpenAIKeyReady: ready,
    service: {
      assertAccountCredentialReady: async (_id: string, _signal: AbortSignal) => {
        gated = true;
        try {
          await ready(_id, _signal);
        } finally {
          gated = false;
        }
      },
    },
  };
  await openAIAccountKeyAuthority(binding).assertReady(signal());
  expect(ready).toHaveBeenCalledWith('work', expect.any(AbortSignal));
  expect(state.key).not.toHaveBeenCalled();
  ready.mockRejectedValueOnce(Error('unresolved rotation'));
  await expect(openAIAccountKeyAuthority(binding).assertReady(signal())).rejects.toThrow(
    'unresolved rotation',
  );
  expect(state.key).not.toHaveBeenCalled();
});
it('rejects controller drift or cancellation during gateway custody checks', async () => {
  const ready = vi.fn(async () => {
    state.runtime = {};
  });
  const runtime = {
    assertOpenAIKeyReady: ready,
    service: { assertAccountCredentialReady: async () => ready() },
  };
  state.runtime = runtime;
  await expect(openAIAccountKeyAuthority(binding).assertReady(signal())).rejects.toThrow(
    'controller changed',
  );
  const controller = new AbortController();
  ready.mockImplementation(async () => {
    controller.abort();
  });
  state.runtime = runtime;
  await expect(openAIAccountKeyAuthority(binding).assertReady(controller.signal)).rejects.toThrow();
  expect(state.key).not.toHaveBeenCalled();
});
it('keeps existing managed keys inside their credential controller', async () => {
  const resolveKey = vi.fn(async () => 'managed-key');
  state.runtime = {
    openAIKeys: { manages: () => true, resolveKey },
    assertOpenAIKeyReady: vi.fn(),
  };
  await expect(openAIAccountKeyAuthority(binding).resolveKey('work', signal())).resolves.toBe(
    'managed-key',
  );
  expect(resolveKey).toHaveBeenCalledWith('work', expect.any(AbortSignal));
  expect(state.key).not.toHaveBeenCalled();
});
it('runs legacy readiness and credential lookup inside the same mutation gate', async () => {
  let gated = false;
  const ready = vi.fn(async () => {
    expect(gated).toBe(true);
  });
  state.key.mockImplementation(async () => {
    expect(gated).toBe(true);
    return 'existing-key';
  });
  state.runtime = {
    assertOpenAIKeyReady: ready,
    service: {
      withCredentialRead: async (work: () => Promise<string>) => {
        gated = true;
        try {
          return await work();
        } finally {
          gated = false;
        }
      },
    },
  };
  await expect(openAIAccountKeyAuthority(binding).resolveKey('work', signal())).resolves.toBe(
    'existing-key',
  );
  expect(ready).toHaveBeenCalledWith('work', expect.any(AbortSignal));
});
it('does not downgrade an enrolled account when its controller is absent', () => {
  state.enrolled = true;
  expect(() => openAIAccountKeyAuthority(binding)).toThrow('controller unavailable');
  expect(state.key).not.toHaveBeenCalled();
});
it('does not fall back to a raw key after a managed credential failure', async () => {
  state.runtime = {
    openAIKeys: {
      manages: () => true,
      resolveKey: async () => {
        throw Error('unconfirmed rotation');
      },
    },
    assertOpenAIKeyReady: vi.fn(),
  };
  await expect(openAIAccountKeyAuthority(binding).resolveKey('work', signal())).rejects.toThrow(
    'unconfirmed rotation',
  );
  expect(state.key).not.toHaveBeenCalled();
});
it('blocks an unresolved journal before any credential lookup', () => {
  state.fence.mockImplementation(() => {
    throw Error('restore controller');
  });
  expect(() => openAIAccountKeyAuthority(binding)).toThrow('restore controller');
  expect(state.key).not.toHaveBeenCalled();
});
it('rejects profile drift while the credential lookup is pending', async () => {
  state.key.mockImplementation(async () => {
    state.validate.mockImplementation(() => {
      throw Error('profile changed');
    });
    return 'existing-key';
  });
  await expect(openAIAccountKeyAuthority(binding).resolveKey('work', signal())).rejects.toThrow(
    'profile changed',
  );
});
it('rejects controller replacement and cancellation before returning a key', async () => {
  state.key.mockImplementation(async () => {
    state.runtime = {};
    return 'existing-key';
  });
  await expect(openAIAccountKeyAuthority(binding).resolveKey('work', signal())).rejects.toThrow(
    'controller changed',
  );
  state.runtime = undefined;
  const controller = new AbortController();
  state.key.mockImplementation(async () => {
    controller.abort();
    return 'existing-key';
  });
  await expect(
    openAIAccountKeyAuthority(binding).resolveKey('work', controller.signal),
  ).rejects.toThrow();
});

it('completes OpenShell readiness inside the real account startup gate', async () => {
  const ready = vi.fn(async () => {});
  const service = new ConnectionsService({ list: () => [] } as never, {} as never, {
    accountCredentialReady: ready,
  });
  state.runtime = { service, assertOpenAIKeyReady: ready };
  const startup = service.withAccountRuntimes('work', async () => {
    await openAIAccountKeyAuthority(binding).assertReady(signal());
    return 'native startup reached';
  });
  let timer: ReturnType<typeof setTimeout>;
  try {
    const result = await Promise.race([
      startup,
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('deadlocked'), 100);
      }),
    ]);
    expect(result).toBe('native startup reached');
    expect(ready).toHaveBeenCalledTimes(2);
    expect(state.key).not.toHaveBeenCalled();
  } finally {
    clearTimeout(timer!);
  }
});
