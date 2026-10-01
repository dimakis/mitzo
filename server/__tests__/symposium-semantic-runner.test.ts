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
