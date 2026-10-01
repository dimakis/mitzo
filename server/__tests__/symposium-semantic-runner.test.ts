import { expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { classifySemanticAttachedNonzero } from '../symposium-artifact-host.js';
import { runOwnedSemanticCriterion } from '../symposium-semantic-criterion-runner.js';
const hash = (x: string) => x.repeat(64);
const definition = {
  id: 'sum',
  criterion: 'Sums values',
  version: 1 as const,
  kind: 'python-json-cases' as const,
  path: 'total.py',
  cases: [
    { id: 'empty', input: [], expected: 0 },
    { id: 'signed', input: [3, -2], expected: 1 },
  ],
};
function fixture(mode = 'correct') {
  const db = new Database(':memory:');
  db.exec(
    'CREATE TABLE symposium_seal_export_jobs(job_id TEXT PRIMARY KEY,fence_id TEXT,operation_id TEXT,kind TEXT,input_json TEXT,custody_digest TEXT,state TEXT,container_name TEXT,container_id TEXT,result_hash TEXT,receipt_json TEXT,helper_image TEXT,export_code_digest TEXT,review_build_version INTEGER)',
  );
  let present = false,
    index = 0,
    exit = 0,
    name = '',
    label = '';
  const cid = hash('e');
  const seal = {
    fenceId: 'fence',
    custodyDigest: hash('a'),
    sessionId: 'session',
    repositoryPath: '.',
    git: { commit: 'b'.repeat(40), committedTreeDigest: hash('c') },
  };
  const command = vi.fn(async (args: readonly string[], _limit?: number, input?: Buffer) => {
    if (args[0] === 'create') {
      present = true;
      name = args[args.indexOf('--name') + 1];
      label = args[args.indexOf('--label') + 1].split('=')[1];
      if (mode === 'lost-create') throw Error('unknown create');
      return cid;
    }
    if (args[0] === 'inspect')
      return JSON.stringify([
        {
          Id: cid,
          Name: name,
          Image: 'd'.repeat(64),
          ImageName: 'sha256:' + 'd'.repeat(64),
          Config: {
            User: 'sandbox',
            Tty: false,
            OpenStdin: true,
            Entrypoint: ['/usr/bin/python3'],
            Cmd: ['-I', '-B', '/artifact/total.py'],
            Labels: { 'mitzo.artifact-export-job': label },
          },
          HostConfig: {
            NetworkMode: 'none',
            ReadonlyRootfs: true,
            Privileged: false,
            CapDrop: [
              'CAP_CHOWN',
              'CAP_DAC_OVERRIDE',
              'CAP_FOWNER',
              'CAP_FSETID',
              'CAP_KILL',
              'CAP_NET_BIND_SERVICE',
              'CAP_SETFCAP',
              'CAP_SETGID',
              'CAP_SETPCAP',
              'CAP_SETUID',
              'CAP_SYS_CHROOT',
            ],
            CapAdd: [],
            SecurityOpt: ['no-new-privileges'],
            PidsLimit: 32,
            Memory: 268435456,
            NanoCpus: 1000000000,
            CpuPeriod: 100000,
            CpuQuota: 100000,
            PidMode: 'private',
            UTSMode: 'private',
            IpcMode: 'private',
            UsernsMode: '',
            PortBindings: null,
            Tmpfs: {},
            Binds: ['volume:/artifact:ro,rprivate,nosuid,nodev,rbind'],
          },
          State: { Status: 'exited', Running: false, ExitCode: exit },
          Mounts: [
            {
              Type: 'volume',
              Name: 'volume',
              Driver: 'local',
              Destination: '/artifact',
              RW: false,
              Mode: '',
              Propagation: 'rprivate',
              Options: ['nosuid', 'nodev', 'rbind'],
            },
          ],
        },
      ]);
    if (args[0] === 'ps') return JSON.stringify(present ? [{ Id: cid, Names: [name] }] : []);
    if (args[0] === 'start') {
      index++;
      expect(input?.toString()).toBe(JSON.stringify(definition.cases[index - 1].input) + '\n');
      if (mode === 'lost-start') throw Error('lost start reply');
      if (mode === 'production-nonzero') {
        exit = 1;
        const error = Object.assign(Error('private Python traceback'), {
          code: 1,
          killed: false,
          signal: null,
        });
        throw classifySemanticAttachedNonzero(args, input, error, 'before-error\n', 16384)!;
      }
      if (mode === 'forged') return JSON.stringify({ pass: true, proof: seal.git });
      if (mode === 'wrong') return '99\n';
      if (mode === 'malformed') return '{';
      if (mode === 'overflow') return 'x'.repeat(16385);
      return JSON.stringify(definition.cases[index - 1].expected) + '\n';
    }
    if (args[0] === 'rm') {
      if (mode === 'cleanup') throw Error('uncertain removal');
      present = false;
      return '';
    }
    if (args[0] === 'stop') {
      exit = 137;
      return '';
    }
    throw Error('unexpected effect ' + args[0]);
  });
  const deps = {
    db,
    command,
    seal,
    volume: 'volume',
    image: 'sha256:' + 'd'.repeat(64),
    target: '/artifact',
    requireSeal: vi.fn(async () => seal),
    custody: vi.fn(async () => {}),
    checkFile: vi.fn(async () => hash('f')),
    withSnapshot: (fn: () => void) => fn(),
  };
  return { db, command, deps };
}
it('compares real command outputs outside artifact process, retains exact receipt and never dispatches duplicate cases', async () => {
  const f = fixture();
  try {
    const receipt = await runOwnedSemanticCriterion(
      f.deps,
      { fenceId: 'fence', operationId: 'semantic', definition },
      new AbortController().signal,
    );
    expect(receipt.cases.map((c) => c.status)).toEqual(['passed', 'passed']);
    expect(
      await runOwnedSemanticCriterion(
        f.deps,
        { fenceId: 'fence', operationId: 'semantic', definition },
        new AbortController().signal,
      ),
    ).toEqual(receipt);
    expect(f.command.mock.calls.filter(([a]) => a[0] === 'create')).toHaveLength(2);
    for (const [args] of f.command.mock.calls.filter(([a]) => a[0] === 'create')) {
      expect(args).toContain('--network=none');
      expect(args).toContain('--read-only');
      expect(args).toContain('--cap-drop=ALL');
      expect(args).toContain('--entrypoint=/usr/bin/python3');
      expect(args).not.toContain('--env');
      expect(args.at(-1)).toBe('/artifact/total.py');
    }
  } finally {
    f.db.close();
  }
});
it.each(['wrong', 'forged', 'malformed', 'overflow'])(
  'fails behavior rather than trusting artifact-provided counters: %s',
  async (mode) => {
    const f = fixture(mode);
    try {
      expect(
        (
          await runOwnedSemanticCriterion(
            f.deps,
            { fenceId: 'fence', operationId: 'semantic', definition },
            new AbortController().signal,
          )
        ).cases.every((c) => c.status !== 'passed'),
      ).toBe(true);
    } finally {
      f.db.close();
    }
  },
);
it.each(['lost-create', 'lost-start', 'cleanup'])(
  'retains uncertain original effects without replay or verified result: %s',
  async (mode) => {
    const f = fixture(mode);
    try {
      await expect(
        runOwnedSemanticCriterion(
          f.deps,
          { fenceId: 'fence', operationId: 'semantic', definition },
          new AbortController().signal,
        ),
      ).rejects.toThrow();
      const creates = f.command.mock.calls.filter(([a]) => a[0] === 'create').length;
      await expect(
        runOwnedSemanticCriterion(
          f.deps,
          { fenceId: 'fence', operationId: 'semantic', definition },
          new AbortController().signal,
        ),
      ).rejects.toThrow(/reconcil|uncertain/i);
      expect(f.command.mock.calls.filter(([a]) => a[0] === 'create')).toHaveLength(creates);
      expect(
        f.db
          .prepare(
            "SELECT COUNT(*) n FROM symposium_seal_export_jobs WHERE kind='semantic' AND state='complete'",
          )
          .get(),
      ).toEqual({ n: 0 });
    } finally {
      f.db.close();
    }
  },
);

it('requires original-ID cleanup reconciliation and never recreates a helper after an uncertain start', async () => {
  const f = fixture('lost-start');
  try {
    const input = { fenceId: 'fence', operationId: 'semantic', definition };
    await expect(
      runOwnedSemanticCriterion(f.deps, input, new AbortController().signal),
    ).rejects.toThrow();
    const module = await import('../symposium-semantic-criterion-runner.js');
    const reconcile = (
      module as unknown as {
        reconcileOwnedSemanticCriterion: (...args: unknown[]) => Promise<unknown>;
      }
    ).reconcileOwnedSemanticCriterion;
    expect(typeof reconcile).toBe('function');
    const before = f.command.mock.calls.filter(([a]) => a[0] === 'create').length;
    expect(await reconcile(f.deps, input, new AbortController().signal)).toMatchObject({
      state: 'failed_cleaned',
      retryAllowed: false,
    });
    expect(f.command.mock.calls.filter(([a]) => a[0] === 'create')).toHaveLength(before);
    await expect(
      runOwnedSemanticCriterion(f.deps, input, new AbortController().signal),
    ).rejects.toThrow(/reconcil/i);
  } finally {
    f.db.close();
  }
});

it('fences an unreturned original start at the fixed timeout without a new allocation or positive evidence', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const f = fixture();
  try {
    const original = f.command.getMockImplementation()!;
    f.command.mockImplementation((args, limit, input) =>
      args[0] === 'start' ? new Promise<string>(() => {}) : original(args, limit, input),
    );
    const pending = runOwnedSemanticCriterion(
      f.deps,
      { fenceId: 'fence', operationId: 'semantic-timeout', definition },
      new AbortController().signal,
    );
    const failure = expect(pending).rejects.toThrow(/reconcil/i);
    await vi.waitFor(() => expect(f.command.mock.calls.some(([a]) => a[0] === 'start')).toBe(true));
    await vi.advanceTimersByTimeAsync(5001);
    await failure;
    expect(f.command.mock.calls.filter(([a]) => a[0] === 'create')).toHaveLength(1);
  } finally {
    vi.useRealTimers();
    f.db.close();
  }
});

it.each(['Image', 'Tty', 'Cmd', 'port', 'RW', 'namespace', 'cpu', 'tmpfs'])(
  'refuses changed physical helper %s before executing or signaling it',
  async (field) => {
    const f = fixture();
    try {
      const original = f.command.getMockImplementation()!;
      f.command.mockImplementation(async (args, limit, input) => {
        const result = await original(args, limit, input);
        if (args[0] !== 'inspect') return result;
        const values = JSON.parse(result),
          c = values[0];
        if (field === 'Image') c.Image = 'f'.repeat(64);
        if (field === 'Tty') c.Config.Tty = true;
        if (field === 'Cmd') c.Config.Cmd = ['-c', 'print(0)'];
        if (field === 'port') c.HostConfig.PortBindings = { '443/tcp': [{}] };
        if (field === 'RW') c.Mounts[0].RW = true;
        if (field === 'namespace') c.HostConfig.PidMode = 'host';
        if (field === 'cpu') c.HostConfig.CpuQuota = 200000;
        if (field === 'tmpfs') c.HostConfig.Tmpfs = { '/usr/bin': 'rw' };
        return JSON.stringify(values);
      });
      await expect(
        runOwnedSemanticCriterion(
          f.deps,
          { fenceId: 'fence', operationId: 'guard', definition },
          new AbortController().signal,
        ),
      ).rejects.toThrow(/reconcil/);
      expect(
        f.command.mock.calls.filter(([a]) => ['start', 'stop', 'rm'].includes(a[0])),
      ).toHaveLength(0);
    } finally {
      f.db.close();
    }
  },
);

it('late IO completion cannot restore a verified receipt after the actual transport deadline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const f = fixture();
  let resolve!: (text: string) => void;
  try {
    const original = f.command.getMockImplementation()!;
    f.command.mockImplementation((args, limit, input) =>
      args[0] === 'start'
        ? new Promise<string>((done) => {
            resolve = done;
          })
        : original(args, limit, input),
    );
    const pending = runOwnedSemanticCriterion(
      f.deps,
      { fenceId: 'fence', operationId: 'late-output', definition },
      new AbortController().signal,
    );
    const failed = expect(pending).rejects.toThrow(/reconcil/);
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    const start = f.command.mock.calls.find(([a]) => a[0] === 'start') as unknown[];
    expect(start[3]).toBe(5000);
    await vi.advanceTimersByTimeAsync(5001);
    await failed;
    resolve('0\n');
    await vi.advanceTimersByTimeAsync(1);
    expect(
      f.db
        .prepare(
          "SELECT COUNT(*) n FROM symposium_seal_export_jobs WHERE kind='semantic' AND state='complete'",
        )
        .get(),
    ).toEqual({ n: 0 });
    expect(f.command.mock.calls.filter(([a]) => a[0] === 'create')).toHaveLength(1);
  } finally {
    vi.useRealTimers();
    f.db.close();
  }
});
it('retains a late known create CID for original cleanup without starting or retrying it', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const f = fixture();
  let resolve!: (text: string) => void;
  try {
    const original = f.command.getMockImplementation()!;
    f.command.mockImplementation((args, limit, input) =>
      args[0] === 'create'
        ? new Promise<string>((done) => {
            resolve = done;
          })
        : original(args, limit, input),
    );
    const pending = runOwnedSemanticCriterion(
        f.deps,
        { fenceId: 'fence', operationId: 'late-create', definition },
        new AbortController().signal,
      ),
      failed = expect(pending).rejects.toThrow(/reconcil/);
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    await vi.advanceTimersByTimeAsync(5001);
    await failed;
    resolve('e'.repeat(64));
    await vi.advanceTimersByTimeAsync(1);
    expect(
      f.db
        .prepare("SELECT container_id FROM symposium_seal_export_jobs WHERE kind='semantic_case'")
        .get(),
    ).toEqual({ container_id: 'e'.repeat(64) });
    expect(f.command.mock.calls.filter(([a]) => a[0] === 'start')).toHaveLength(0);
    await expect(
      runOwnedSemanticCriterion(
        f.deps,
        { fenceId: 'fence', operationId: 'late-create', definition },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/reconcil/);
  } finally {
    vi.useRealTimers();
    f.db.close();
  }
});

it('rejects a late completion timestamp even when its callback beats the timer queue', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const f = fixture();
  let clock = 0;
  const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
  try {
    const original = f.command.getMockImplementation()!;
    f.command.mockImplementation(async (args, limit, input) => {
      const output = await original(args, limit, input);
      if (args[0] === 'start') clock += 5001;
      return output;
    });
    await expect(
      runOwnedSemanticCriterion(
        f.deps,
        { fenceId: 'fence', operationId: 'late-clock', definition },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/reconcil/);
    expect(
      f.db
        .prepare(
          "SELECT COUNT(*) n FROM symposium_seal_export_jobs WHERE kind='semantic' AND state='complete'",
        )
        .get(),
    ).toEqual({ n: 0 });
  } finally {
    now.mockRestore();
    vi.useRealTimers();
    f.db.close();
  }
});

it('floors fractional remaining execution time through the actual retained command validator', async () => {
  const f = fixture();
  let clock = 0,
    calls = 0;
  const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
  try {
    f.deps.requireSeal.mockImplementation(async () => {
      if (++calls === 3) clock = 35000.25;
      return f.deps.seal;
    });
    const original = f.command.getMockImplementation()!;
    f.command.mockImplementation(async (args, limit, input) => {
      const output = await original(args, limit, input);
      clock += 2000.1;
      return output;
    });
    const { ArtifactPodmanContext } = await import('../symposium-artifact-host.js');
    const deps = { ...f.deps, command: new ArtifactPodmanContext(f.command).verifierCommand() };
    const receipt = await runOwnedSemanticCriterion(
      deps,
      {
        fenceId: 'fence',
        operationId: 'fractional-budget',
        definition: { ...definition, cases: [definition.cases[0]] },
      },
      new AbortController().signal,
    );
    expect(receipt.cases[0].status).toBe('passed');
    const bounded = f.command.mock.calls
      .map((call) => (call as unknown[])[3])
      .filter((ms): ms is number => typeof ms === 'number');
    expect(bounded.some((ms) => ms > 0 && ms < 5000)).toBe(true);
    expect(bounded.every(Number.isInteger)).toBe(true);
  } finally {
    now.mockRestore();
    f.db.close();
  }
});

it('original cleanup retirement fences a suspended runner before any later case allocation', async () => {
  const f = fixture();
  let release!: () => void,
    count = 0;
  try {
    f.deps.requireSeal.mockImplementation(async () => {
      if (++count === 3)
        await new Promise<void>((done) => {
          release = done;
        });
      return f.deps.seal;
    });
    const input = { fenceId: 'fence', operationId: 'concurrent-retirement', definition };
    const pending = runOwnedSemanticCriterion(f.deps, input, new AbortController().signal),
      failed = expect(pending).rejects.toThrow(/reconcil|changed/i);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const { reconcileOwnedSemanticCriterion } =
      await import('../symposium-semantic-criterion-runner.js');
    expect(
      await reconcileOwnedSemanticCriterion(f.deps, input, new AbortController().signal),
    ).toMatchObject({ state: 'failed_cleaned', retryAllowed: false });
    release();
    await failed;
    expect(f.command.mock.calls.filter(([a]) => a[0] === 'create')).toHaveLength(0);
    expect(
      f.db
        .prepare("SELECT COUNT(*) n FROM symposium_seal_export_jobs WHERE kind='semantic_case'")
        .get(),
    ).toEqual({ n: 0 });
  } finally {
    f.db.close();
  }
});

it('final cleanup rejects a case created while final seal authority was awaited', async () => {
  const f = fixture();
  let runnerRelease!: () => void,
    cleanupRelease!: () => void,
    startRelease!: (text: string) => void,
    calls = 0;
  const input = { fenceId: 'fence', operationId: 'final-child-window', definition };
  try {
    f.deps.requireSeal.mockImplementation(async () => {
      const call = ++calls;
      if (call === 3)
        await new Promise<void>((done) => {
          runnerRelease = done;
        });
      if (call === 5)
        await new Promise<void>((done) => {
          cleanupRelease = done;
        });
      return f.deps.seal;
    });
    const running = runOwnedSemanticCriterion(f.deps, input, new AbortController().signal);
    const settled = running.catch(() => null);
    await vi.waitFor(() => expect(runnerRelease).toBeTypeOf('function'));
    const { reconcileOwnedSemanticCriterion } =
      await import('../symposium-semantic-criterion-runner.js');
    const cleaning = reconcileOwnedSemanticCriterion(f.deps, input, new AbortController().signal);
    const rejected = expect(cleaning).rejects.toThrow(/membership|case|journal|changed/i);
    await vi.waitFor(() => expect(cleanupRelease).toBeTypeOf('function'));
    const original = f.command.getMockImplementation()!;
    f.command.mockImplementation((args, limit, data) =>
      args[0] === 'start'
        ? new Promise<string>((done) => {
            startRelease = done;
          })
        : original(args, limit, data),
    );
    runnerRelease();
    await vi.waitFor(() => expect(startRelease).toBeTypeOf('function'));
    expect(
      f.db
        .prepare(
          "SELECT COUNT(*) n FROM symposium_seal_export_jobs WHERE kind='semantic_case' AND state='start_uncertain'",
        )
        .get(),
    ).toEqual({ n: 1 });
    cleanupRelease();
    await rejected;
    expect(
      f.db.prepare("SELECT state FROM symposium_seal_export_jobs WHERE kind='semantic'").get(),
    ).toEqual({ state: 'in_progress' });
    const before = f.command.mock.calls.filter(([a]) => ['stop', 'rm'].includes(a[0])).length;
    startRelease('0\n');
    await vi.waitFor(() =>
      expect(f.command.mock.calls.filter(([a]) => a[0] === 'start')).toHaveLength(2),
    );
    startRelease('1\n');
    await settled;
    expect(
      f.command.mock.calls.filter(([a]) => ['stop', 'rm'].includes(a[0])).length,
    ).toBeGreaterThan(before);
  } finally {
    f.db.close();
  }
});

it.each([
  'bind-extra',
  'bind-missing',
  'bind-duplicate',
  'bind-rw',
  'bind-shared',
  'bind-foreign-source',
  'bind-foreign-target',
  'bind-extra-mount',
  'mount-extra',
  'mount-missing',
  'mount-duplicate',
  'mount-driver',
  'mount-mode',
  'mount-shared',
])(
  'rejects hostile normalized semantic mount %s before start or cleanup signals',
  async (variant) => {
    const f = fixture();
    try {
      const original = f.command.getMockImplementation()!;
      f.command.mockImplementation(async (args, limit, input) => {
        const result = await original(args, limit, input);
        if (args[0] !== 'inspect') return result;
        const values = JSON.parse(result),
          c = values[0],
          m = c.Mounts[0];
        if (variant === 'bind-extra') c.HostConfig.Binds[0] += ',nocopy';
        if (variant === 'bind-missing')
          c.HostConfig.Binds[0] = c.HostConfig.Binds[0].replace(',nosuid', '');
        if (variant === 'bind-duplicate') c.HostConfig.Binds[0] += ',ro';
        if (variant === 'bind-rw') c.HostConfig.Binds[0] += ',rw';
        if (variant === 'bind-shared')
          c.HostConfig.Binds[0] = c.HostConfig.Binds[0].replace('rprivate', 'rshared');
        if (variant === 'bind-foreign-source')
          c.HostConfig.Binds[0] = c.HostConfig.Binds[0].replace('volume:', 'foreign:');
        if (variant === 'bind-foreign-target')
          c.HostConfig.Binds[0] = c.HostConfig.Binds[0].replace('/artifact:', '/usr/bin:');
        if (variant === 'bind-extra-mount') c.HostConfig.Binds.push(c.HostConfig.Binds[0]);
        if (variant === 'mount-extra') m.Options.push('nocopy');
        if (variant === 'mount-missing') m.Options.pop();
        if (variant === 'mount-duplicate') m.Options.push('nosuid');
        if (variant === 'mount-driver') m.Driver = 'foreign';
        if (variant === 'mount-mode') m.Mode = 'z';
        if (variant === 'mount-shared') m.Propagation = 'shared';
        return JSON.stringify(values);
      });
      await expect(
        runOwnedSemanticCriterion(
          f.deps,
          { fenceId: 'fence', operationId: 'hostile-mount', definition },
          new AbortController().signal,
        ),
      ).rejects.toThrow(/reconcil/);
      expect(
        f.command.mock.calls.filter(([args]) => ['start', 'stop', 'rm'].includes(args[0])),
      ).toHaveLength(0);
    } finally {
      f.db.close();
    }
  },
);
it('accepts only the exact normalized options independent of source option ordering', async () => {
  const f = fixture();
  try {
    const original = f.command.getMockImplementation()!;
    f.command.mockImplementation(async (args, limit, input) => {
      const result = await original(args, limit, input);
      if (args[0] !== 'inspect') return result;
      const values = JSON.parse(result);
      values[0].Mounts[0].Options.reverse();
      values[0].HostConfig.Binds = ['volume:/artifact:rbind,nodev,nosuid,rprivate,ro'];
      return JSON.stringify(values);
    });
    expect(
      (
        await runOwnedSemanticCriterion(
          f.deps,
          { fenceId: 'fence', operationId: 'normalized-order', definition },
          new AbortController().signal,
        )
      ).cases.every((c) => c.status === 'passed'),
    ).toBe(true);
  } finally {
    f.db.close();
  }
});

it('records an exact terminal Python nonzero as failed criterion when attached transport rejects', async () => {
  const f = fixture('production-nonzero');
  try {
    const result = await runOwnedSemanticCriterion(
      f.deps,
      { fenceId: 'fence', operationId: 'nonzero-terminal', definition },
      new AbortController().signal,
    );
    expect(result.cases.map((item) => item.status)).toEqual(['nonzero', 'nonzero']);
  } finally {
    f.db.close();
  }
});

it('retains actual bounded stdout for nonzero only and never exposes it through errors', async () => {
  const f = fixture('production-nonzero');
  try {
    const result = await runOwnedSemanticCriterion(
      f.deps,
      { fenceId: 'fence', operationId: 'nonzero-capture', definition },
      new AbortController().signal,
    );
    expect(
      result.cases.every(
        (item) => item.stdoutCapturedBytes === Buffer.byteLength('before-error\n'),
      ),
    ).toBe(true);
    const error = classifySemanticAttachedNonzero(
      ['start', '--attach', '--interactive', hash('e')],
      Buffer.from('null\n'),
      Object.assign(Error('PRIVATE_TRACEBACK'), { code: 1 }),
      'PRIVATE_STDOUT',
      16384,
    )!;
    expect(JSON.stringify(error)).not.toContain('PRIVATE');
    expect(error.message).not.toContain('PRIVATE');
    expect(error.cause).toBeUndefined();
    expect(error.capturedStdout()).toBe('PRIVATE_STDOUT');
  } finally {
    f.db.close();
  }
});

it.each([
  { code: 'ENOENT' },
  { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' },
  { code: 1, killed: true },
  { code: 1, signal: 'SIGTERM' },
  { code: 0 },
  { code: 256 },
  { code: 1.5 },
])(
  'never classifies transport/timeout/overflow uncertainty as terminal evidence: %j',
  (properties) => {
    expect(
      classifySemanticAttachedNonzero(
        ['start', '--attach', '--interactive', hash('e')],
        Buffer.from('null\n'),
        Object.assign(Error('private'), properties),
        '',
        16384,
      ),
    ).toBeUndefined();
  },
);
it('requires captured stdout, exact interactive semantic request and no stdin failure', () => {
  const error = Object.assign(Error('private'), { code: 1 });
  const args = ['start', '--attach', '--interactive', hash('e')];
  for (const output of [undefined, null, Buffer.from('x'), 'x'.repeat(16385)])
    expect(
      classifySemanticAttachedNonzero(args, Buffer.from('null\n'), error, output, 16384),
    ).toBeUndefined();
  expect(classifySemanticAttachedNonzero(args, undefined, error, '', 16384)).toBeUndefined();
  expect(
    classifySemanticAttachedNonzero(args, Buffer.from('null\n'), error, '', 16384, true),
  ).toBeUndefined();
  expect(
    classifySemanticAttachedNonzero(
      ['start', '--attach', hash('e')],
      Buffer.from('null\n'),
      error,
      '',
      16384,
    ),
  ).toBeUndefined();
  expect(
    classifySemanticAttachedNonzero(
      ['inspect', hash('e')],
      Buffer.from('null\n'),
      error,
      '',
      16384,
    ),
  ).toBeUndefined();
});
it.each(['running', 'wrong-exit', 'unknown-status', 'wrong-cid', 'generic-loss'])(
  'never records favorable or completed case for uncertain nonzero %s',
  async (mode) => {
    const f = fixture('production-nonzero');
    const original = f.command.getMockImplementation()!;
    let started = false;
    f.command.mockImplementation(async (args, limit, input) => {
      if (args[0] === 'start') {
        started = true;
        if (mode === 'generic-loss') throw Error('Owned Podman operation failed');
      }
      const result = await original(args, limit, input);
      if (started && args[0] === 'inspect') {
        const rows = JSON.parse(result);
        if (mode === 'running') rows[0].State.Running = true;
        if (mode === 'wrong-exit') rows[0].State.ExitCode = 0;
        if (mode === 'unknown-status') rows[0].State.Status = 'unknown';
        if (mode === 'wrong-cid') rows[0].Id = hash('a');
        return JSON.stringify(rows);
      }
      return result;
    });
    try {
      await expect(
        runOwnedSemanticCriterion(
          f.deps,
          { fenceId: 'fence', operationId: 'nonzero-uncertain', definition },
          new AbortController().signal,
        ),
      ).rejects.toThrow('requires reconciliation');
      expect(
        f.db
          .prepare("SELECT count(*) n FROM symposium_seal_export_jobs WHERE state='complete'")
          .get(),
      ).toMatchObject({ n: 0 });
    } finally {
      f.db.close();
    }
  },
);

it('blocks nonzero outcome when custody changes after the typed original transport result', async () => {
  const f = fixture('production-nonzero');
  const original = f.command.getMockImplementation()!;
  let started = false;
  f.command.mockImplementation(async (args, limit, input) => {
    if (args[0] === 'start') started = true;
    return original(args, limit, input);
  });
  f.deps.custody.mockImplementation(async () => {
    if (started) throw Error('custody revoked');
  });
  try {
    await expect(
      runOwnedSemanticCriterion(
        f.deps,
        { fenceId: 'fence', operationId: 'nonzero-custody', definition },
        new AbortController().signal,
      ),
    ).rejects.toThrow('requires reconciliation');
    expect(
      f.db
        .prepare('SELECT count(*) n FROM symposium_seal_export_jobs WHERE receipt_json IS NOT NULL')
        .get(),
    ).toMatchObject({ n: 0 });
    expect(f.command.mock.calls.filter(([args]) => ['stop', 'rm'].includes(args[0]))).toHaveLength(
      0,
    );
  } finally {
    f.db.close();
  }
});

it('late typed nonzero callback cannot bypass the per-command monotonic deadline', async () => {
  let clock = 0;
  const now = vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const f = fixture('production-nonzero');
  const original = f.command.getMockImplementation()!;
  f.command.mockImplementation(async (args, limit, input) => {
    if (args[0] === 'start') clock += 5001;
    return original(args, limit, input);
  });
  try {
    await expect(
      runOwnedSemanticCriterion(
        f.deps,
        { fenceId: 'fence', operationId: 'late-typed-nonzero', definition },
        new AbortController().signal,
      ),
    ).rejects.toThrow('requires reconciliation');
    expect(
      f.db
        .prepare("SELECT count(*) n FROM symposium_seal_export_jobs WHERE state='complete'")
        .get(),
    ).toMatchObject({ n: 0 });
    expect(f.command.mock.calls.filter(([args]) => args[0] === 'start')).toHaveLength(1);
  } finally {
    now.mockRestore();
    f.db.close();
  }
});

it('retires only the original witnessed CID after CLI local write but lost create stdout, without starting or replay', async () => {
  const { SemanticCidWitnessOwner } = await import('../symposium-semantic-cid-witness.js');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { reconcileOwnedSemanticCriterion } =
    await import('../symposium-semantic-criterion-runner.js');
  const f = fixture(),
    root = mkdtempSync(join(tmpdir(), 'semantic-local-cid-loss-')),
    journal = join(root, 'journal.db');
  writeFileSync(journal, '', { mode: 0o600 });
  const witness = new SemanticCidWitnessOwner(journal);
  const deps = { ...f.deps, cidWitness: witness };
  f.db.exec('ALTER TABLE symposium_seal_export_jobs ADD COLUMN cid_witness_json TEXT');
  const original = f.command.getMockImplementation()!;
  f.command.mockImplementation(async (...args) => {
    const result = await original(...args);
    if (args[0][0] === 'create') {
      const row = f.db
        .prepare("SELECT * FROM symposium_seal_export_jobs WHERE kind='semantic_case'")
        .get() as Record<string, string>;
      // Actual retained runner must persist the owner-bound manifest before create.
      const manifest = JSON.parse(row.cid_witness_json);
      expect(args[0][args[0].indexOf('--cidfile') + 1]).toBe(manifest.path);
      writeFileSync(manifest.path, result);
      throw Error('lost stdout after original CLI CID write');
    }
    return result;
  });
  const input = { fenceId: 'fence', operationId: 'local-cid-loss', definition };
  try {
    await expect(
      runOwnedSemanticCriterion(deps, input, new AbortController().signal),
    ).rejects.toThrow();
    expect(
      (
        f.db
          .prepare("SELECT container_id FROM symposium_seal_export_jobs WHERE kind='semantic_case'")
          .get() as { container_id: null }
      ).container_id,
    ).toBeNull();
    await expect(
      reconcileOwnedSemanticCriterion(deps, input, new AbortController().signal),
    ).resolves.toMatchObject({ state: 'failed_cleaned', retryAllowed: false });
    expect(f.command.mock.calls.filter((c) => c[0][0] === 'create')).toHaveLength(1);
    expect(f.command.mock.calls.some((c) => c[0][0] === 'start')).toBe(false);
    expect(f.command.mock.calls.find((c) => c[0][0] === 'rm')?.[0]).toEqual(['rm', 'e'.repeat(64)]);
    expect(
      f.db.prepare("SELECT 1 FROM symposium_seal_export_jobs WHERE state='complete'").get(),
    ).toBeUndefined();
  } finally {
    f.db.close();
  }
});

it.each([
  'pre-write',
  'partial',
  'replaced-inode',
  'same-name-replacement',
  'changed-custody',
  'old-code',
])(
  'never signals or completes an uncertain original create with %s witness proof',
  async (mode) => {
    const { SemanticCidWitnessOwner } = await import('../symposium-semantic-cid-witness.js');
    const { mkdtempSync, writeFileSync, renameSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const { reconcileOwnedSemanticCriterion } =
      await import('../symposium-semantic-criterion-runner.js');
    const f = fixture(),
      root = mkdtempSync(join(tmpdir(), 'semantic-cid-negative-')),
      journal = join(root, 'journal.db');
    writeFileSync(journal, '', { mode: 0o600 });
    const deps = { ...f.deps, cidWitness: new SemanticCidWitnessOwner(journal) };
    f.db.exec('ALTER TABLE symposium_seal_export_jobs ADD COLUMN cid_witness_json TEXT');
    const original = f.command.getMockImplementation()!;
    let manifestPath = '';
    f.command.mockImplementation(async (...args) => {
      let result = await original(...args);
      if (args[0][0] === 'create') {
        const row = f.db
          .prepare("SELECT * FROM symposium_seal_export_jobs WHERE kind='semantic_case'")
          .get() as { cid_witness_json: string };
        manifestPath = JSON.parse(row.cid_witness_json).path;
        if (mode !== 'pre-write')
          writeFileSync(manifestPath, mode === 'partial' ? 'e'.repeat(63) : result);
        if (mode === 'replaced-inode') {
          renameSync(manifestPath, manifestPath + '.original');
          writeFileSync(manifestPath, result, { mode: 0o600 });
        }
        throw Error('lost original create stdout');
      }
      if (mode === 'same-name-replacement' && args[0][0] === 'inspect') {
        const rows = JSON.parse(result);
        rows[0].Id = '1'.repeat(64);
        result = JSON.stringify(rows);
      }
      return result;
    });
    const input = { fenceId: 'fence', operationId: 'negative-witness-' + mode, definition };
    try {
      await expect(
        runOwnedSemanticCriterion(deps, input, new AbortController().signal),
      ).rejects.toThrow();
      if (mode === 'changed-custody')
        f.db
          .prepare(
            "UPDATE symposium_seal_export_jobs SET custody_digest=? WHERE kind='semantic_case'",
          )
          .run('1'.repeat(64));
      if (mode === 'old-code')
        f.db
          .prepare('UPDATE symposium_seal_export_jobs SET export_code_digest=?')
          .run('1'.repeat(64));
      await expect(
        reconcileOwnedSemanticCriterion(deps, input, new AbortController().signal),
      ).rejects.toThrow();
      expect(f.command.mock.calls.some((c) => ['start', 'stop', 'rm'].includes(c[0][0]))).toBe(
        false,
      );
      expect(
        f.db
          .prepare(
            "SELECT 1 FROM symposium_seal_export_jobs WHERE state IN ('complete','failed_cleaned')",
          )
          .get(),
      ).toBeUndefined();
      expect(manifestPath).not.toBe('');
    } finally {
      f.db.close();
    }
  },
);

it.each(['complete', 'in_progress'])(
  'never silently upgrades older %s immutable operations',
  async (state) => {
    const { reconcileOwnedSemanticCriterion } =
      await import('../symposium-semantic-criterion-runner.js');
    const f = fixture();
    const input = { fenceId: 'fence', operationId: 'previous-generation', definition };
    try {
      await runOwnedSemanticCriterion(f.deps, input, new AbortController().signal);
      f.db
        .prepare('UPDATE symposium_seal_export_jobs SET export_code_digest=?')
        .run('1'.repeat(64));
      f.db
        .prepare("UPDATE symposium_seal_export_jobs SET state=? WHERE kind='semantic'")
        .run(state);
      const before = f.db.prepare('SELECT * FROM symposium_seal_export_jobs ORDER BY job_id').all();
      await expect(
        runOwnedSemanticCriterion(f.deps, input, new AbortController().signal),
      ).rejects.toThrow();
      await expect(
        reconcileOwnedSemanticCriterion(f.deps, input, new AbortController().signal),
      ).rejects.toThrow();
      expect(
        f.db.prepare('SELECT * FROM symposium_seal_export_jobs ORDER BY job_id').all(),
      ).toEqual(before);
    } finally {
      f.db.close();
    }
  },
);

it('retains private preparation evidence and dispatches nothing after witness journal CAS failure', async () => {
  const { SemanticCidWitnessOwner } = await import('../symposium-semantic-cid-witness.js');
  const { mkdtempSync, writeFileSync, readdirSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const f = fixture(),
    root = mkdtempSync(join(tmpdir(), 'semantic-witness-cas-')),
    journal = join(root, 'journal.db');
  writeFileSync(journal, '', { mode: 0o600 });
  const deps = { ...f.deps, cidWitness: new SemanticCidWitnessOwner(journal) };
  f.db.exec(
    "ALTER TABLE symposium_seal_export_jobs ADD COLUMN cid_witness_json TEXT; CREATE TRIGGER witness_write_failure BEFORE UPDATE OF cid_witness_json ON symposium_seal_export_jobs BEGIN SELECT RAISE(ABORT,'synthetic journal failure'); END;",
  );
  const input = { fenceId: 'fence', operationId: 'witness-cas-failure', definition };
  try {
    await expect(
      runOwnedSemanticCriterion(deps, input, new AbortController().signal),
    ).rejects.toThrow();
    expect(f.command).not.toHaveBeenCalled();
    const privateRoot = join(root, '.semantic-cid-witness-v1'),
      jobs = readdirSync(privateRoot);
    expect(jobs).toHaveLength(1);
    const manifest = JSON.parse(readFileSync(join(privateRoot, jobs[0], 'manifest.json'), 'utf8'));
    expect(manifest.version).toBe(1);
    expect(readFileSync(manifest.path)).toHaveLength(0);
    await expect(
      runOwnedSemanticCriterion(deps, input, new AbortController().signal),
    ).rejects.toThrow();
    expect(readdirSync(privateRoot)).toEqual(jobs);
    expect(
      f.db
        .prepare(
          "SELECT cid_witness_json FROM symposium_seal_export_jobs WHERE kind='semantic_case'",
        )
        .get(),
    ).toEqual({ cid_witness_json: null });
  } finally {
    f.db.close();
  }
});

it.each(['late-original', 'revoked', 'fresh-inspect-drift', 'failed-removal', 'late-replacement'])(
  'never retires from stale pre-witness census: %s',
  async (mode) => {
    const { SemanticCidWitnessOwner } = await import('../symposium-semantic-cid-witness.js');
    const { reconcileOwnedSemanticCriterion } =
      await import('../symposium-semantic-criterion-runner.js');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const f = fixture(),
      root = mkdtempSync(join(tmpdir(), 'semantic-late-original-')),
      journal = join(root, 'journal.db');
    writeFileSync(journal, '', { mode: 0o600 });
    let current = true;
    const deps = {
      ...f.deps,
      cidWitness: new SemanticCidWitnessOwner(journal),
      withSnapshot: (fn: () => void) => {
        if (!current) throw Error('revoked cleanup');
        return fn();
      },
    };
    f.db.exec('ALTER TABLE symposium_seal_export_jobs ADD COLUMN cid_witness_json TEXT');
    const original = f.command.getMockImplementation()!;
    let pendingArgs: Parameters<typeof original>,
      enter!: () => void,
      finish!: () => void,
      empty = true,
      inspecting = 0;
    const entered = new Promise<void>((r) => (enter = r)),
      finished = new Promise<void>((r) => (finish = r));
    f.command.mockImplementation(async (...args) => {
      if (args[0][0] === 'create') {
        pendingArgs = args;
        enter();
        await finished;
        throw Error('lost stdout after original local write');
      }
      let result = await original(...args);
      if (args[0][0] === 'ps' && empty) {
        empty = false;
        expect(JSON.parse(result)).toEqual([]);
        const cid = await original(...pendingArgs);
        const row = f.db
          .prepare(
            "SELECT cid_witness_json FROM symposium_seal_export_jobs WHERE kind='semantic_case'",
          )
          .get() as { cid_witness_json: string };
        writeFileSync(JSON.parse(row.cid_witness_json).path, cid);
        finish();
      } else if (args[0][0] === 'ps' && mode === 'late-replacement') {
        const row = f.db
          .prepare(
            "SELECT container_name FROM symposium_seal_export_jobs WHERE kind='semantic_case'",
          )
          .get() as { container_name: string };
        result = JSON.stringify([{ Id: '1'.repeat(64), Names: [row.container_name] }]);
      }
      if (args[0][0] === 'inspect') {
        inspecting++;
        if (mode === 'revoked' && inspecting === 1) current = false;
        if (mode === 'fresh-inspect-drift' && inspecting > 1) {
          const raw = JSON.parse(result);
          raw[0].Mounts[0].RW = true;
          result = JSON.stringify(raw);
        }
      }
      if (args[0][0] === 'rm' && mode === 'failed-removal') {
        await original(...pendingArgs);
      }
      return result;
    });
    const input = { fenceId: 'fence', operationId: 'late-original-' + mode, definition };
    const run = runOwnedSemanticCriterion(deps, input, new AbortController().signal).catch(
      (e) => e,
    );
    await entered;
    try {
      if (mode === 'late-original') {
        expect(
          (await reconcileOwnedSemanticCriterion(deps, input, new AbortController().signal)).state,
        ).toBe('failed_cleaned');
        expect(
          JSON.parse(await original(['ps', '--all', '--no-trunc', '--format', 'json'])),
        ).toEqual([]);
        expect(f.command.mock.calls.filter((c) => c[0][0] === 'rm')).toHaveLength(1);
      } else {
        await expect(
          reconcileOwnedSemanticCriterion(deps, input, new AbortController().signal),
        ).rejects.toThrow();
        expect(
          f.db.prepare("SELECT state FROM symposium_seal_export_jobs WHERE kind='semantic'").get(),
        ).toEqual({ state: 'in_progress' });
      }
      expect(f.command.mock.calls.filter((c) => c[0][0] === 'create')).toHaveLength(1);
      expect(f.command.mock.calls.some((c) => c[0][0] === 'start')).toBe(false);
    } finally {
      await run;
      f.db.close();
    }
  },
);

it('exports the original unwitnessed quarantined check without commands, mutation or favorable authority', async () => {
  const f = fixture('lost-create');
  const input = { fenceId: 'fence', operationId: 'semantic', definition };
  try {
    await expect(
      runOwnedSemanticCriterion(f.deps, input, new AbortController().signal),
    ).rejects.toThrow();
    const before = f.db.prepare('SELECT * FROM symposium_seal_export_jobs ORDER BY job_id').all();
    f.command.mockClear();
    const { inspectOwnedSemanticCheckState } =
      await import('../symposium-semantic-criterion-runner.js');
    const report = inspectOwnedSemanticCheckState(f.deps, input, () => {});
    expect(report).toMatchObject({
      kind: 'quarantined-check-state',
      operationId: 'semantic',
      fenceId: 'fence',
      retryAllowed: false,
      executionAuthorized: false,
      cleanupConfirmed: false,
      semanticEvidenceAllowed: false,
      parentState: 'in_progress',
      sourceCompatible: true,
    });
    expect(report.cases).toEqual([
      {
        id: 'empty',
        state: 'create_uncertain',
        originalCidRetained: false,
        witnessManifestRetained: false,
      },
      {
        id: 'signed',
        state: 'not_journaled',
        originalCidRetained: false,
        witnessManifestRetained: false,
      },
    ]);
    expect(f.command).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT * FROM symposium_seal_export_jobs ORDER BY job_id').all()).toEqual(
      before,
    );
    expect(JSON.stringify(report)).not.toMatch(
      /container_name|input_json|sourceSha256|receipt_json|cid_witness_json/,
    );
    expect(() =>
      inspectOwnedSemanticCheckState(
        f.deps,
        { ...input, definition: { ...definition, path: 'other.py' } },
        () => {},
      ),
    ).toThrow();
    expect(() =>
      inspectOwnedSemanticCheckState(f.deps, input, () => {
        throw Error('revoked');
      }),
    ).toThrow('revoked');
  } finally {
    f.db.close();
  }
});
it('preserves incompatible historical source and rejects malformed journal state in read-only reports', async () => {
  const f = fixture('lost-create');
  const input = { fenceId: 'fence', operationId: 'semantic', definition };
  try {
    await expect(
      runOwnedSemanticCriterion(f.deps, input, new AbortController().signal),
    ).rejects.toThrow();
    const { inspectOwnedSemanticCheckState } =
      await import('../symposium-semantic-criterion-runner.js');
    f.db.prepare('UPDATE symposium_seal_export_jobs SET export_code_digest=?').run('a'.repeat(64));
    expect(inspectOwnedSemanticCheckState(f.deps, input, () => {}).sourceCompatible).toBe(false);
    f.db
      .prepare("UPDATE symposium_seal_export_jobs SET state='invented' WHERE kind='semantic_case'")
      .run();
    expect(() => inspectOwnedSemanticCheckState(f.deps, input, () => {})).toThrow();
  } finally {
    f.db.close();
  }
});
