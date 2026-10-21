import { expect, it } from 'vitest';
import { GithubMainPublication } from '../github-main-publication.js';
import { RequestGithubMainPublicationSchema } from '../telos-main-publication-contract.js';
import {
  fixture,
  pins,
  config,
  head,
  main,
  merge,
  approved,
} from './fixtures/github-main-publication.js';
const signal = () => new AbortController().signal;
it('normal PR amendment: main may advance to an ancestor of H after final inspection; observed admission is not base CAS', async () => {
  const f = fixture();
  const advanced = 'd'.repeat(40);
  let reads = 0;
  f.state.afterRead = (path) => {
    if (path.endsWith('/git/ref/heads/main') && !f.state.merged && ++reads === 2) {
      f.state.currentMain = advanced;
      f.state.base = advanced;
    }
  };
  let admitted = '';
  let acknowledged = '';
  const result = await f.adapter.merge(
    pins,
    signal(),
    (ready) => {
      admitted = ready.mainHead;
    },
    (sha) => {
      acknowledged = sha;
    },
  );
  expect(result).toEqual({
    state: 'accepted',
    mergeCommit: merge,
    baseHead: advanced,
    mainHead: merge,
  });
  expect(admitted).toBe(main);
  expect(acknowledged).toBe(merge);
  expect(f.state.mutations).toBe(1);
});

it('has a strict intent schema with no actor, credentials, approval or evidence', () => {
  expect(RequestGithubMainPublicationSchema.parse(pins.input)).toEqual(pins.input);
  for (const field of [
    'actor',
    'repository',
    'credentials',
    'approved',
    'evidence',
    'mergeMethod',
    'resource',
    'repositoryId',
    'pullRequestId',
    'mainHead',
  ])
    expect(
      RequestGithubMainPublicationSchema.safeParse({ ...pins.input, [field]: 'forged' }).success,
    ).toBe(false);
});
it('normal PR amendment: verifies current protection, source review, CI and observed main before readiness', async () => {
  const f = fixture();
  expect(await f.adapter.inspect(pins, signal())).toMatchObject({ state: 'ready', mainHead: main });
  expect(f.state.mutations).toBe(0);
  expect(f.calls.some((c) => c.args.includes('--paginate'))).toBe(true);
});
it('normal PR amendment: executes one constrained HEAD-CAS squash and verifies original PR/main result', async () => {
  const f = fixture();
  let admissions = 0;
  let ack = '';
  expect(
    await f.adapter.merge(
      pins,
      signal(),
      () => {
        admissions++;
      },
      (sha) => {
        ack = sha;
      },
    ),
  ).toEqual({ state: 'accepted', mergeCommit: merge, baseHead: main, mainHead: merge });
  expect(admissions).toBe(1);
  expect(ack).toBe(merge);
  expect(f.state.mutations).toBe(1);
  const effects = f.calls.filter((c) => c.args.some((arg) => arg.includes('mergePullRequest(')));
  expect(effects).toHaveLength(1);
  expect(effects[0]!.args).toEqual([
    'api',
    'graphql',
    '-f',
    expect.stringContaining('expectedHeadOid:$head,mergeMethod:SQUASH'),
    '-f',
    `pullRequest=${pins.resource.pullRequestNodeId}`,
    '-f',
    `head=${head}`,
  ]);
  expect(f.calls.some((c) => c.args.includes('PUT'))).toBe(false);
});
it.each([
  [
    'account',
    (s: ReturnType<typeof fixture>['state']) => {
      s.identity = 'different';
    },
  ],
  [
    'source',
    (s: ReturnType<typeof fixture>['state']) => {
      s.sourceHead = 'd'.repeat(40);
    },
  ],
  [
    'main',
    (s: ReturnType<typeof fixture>['state']) => {
      s.currentMain = 'd'.repeat(40);
    },
  ],
  [
    'base',
    (s: ReturnType<typeof fixture>['state']) => {
      s.base = 'd'.repeat(40);
    },
  ],
  [
    'draft',
    (s: ReturnType<typeof fixture>['state']) => {
      s.draft = true;
    },
  ],
  [
    'strict base fence',
    (s: ReturnType<typeof fixture>['state']) => {
      s.strict = false;
    },
  ],
  [
    'admin fence',
    (s: ReturnType<typeof fixture>['state']) => {
      s.enforceAdmins = false;
    },
  ],
  [
    'App identity',
    (s: ReturnType<typeof fixture>['state']) => {
      s.centaurAppId = 999;
    },
  ],
  [
    'required protection',
    (s: ReturnType<typeof fixture>['state']) => {
      s.protectedChecks = ['Centaur final LGTM'];
    },
  ],
  [
    'combined base',
    (s: ReturnType<typeof fixture>['state']) => {
      s.headContainsBase = false;
    },
  ],
  [
    'reviewer',
    (s: ReturnType<typeof fixture>['state']) => {
      s.reviewer = 'untrusted';
    },
  ],
  [
    'dismissed',
    (s: ReturnType<typeof fixture>['state']) => {
      s.reviewState = 'DISMISSED';
    },
  ],
  [
    'blocking',
    (s: ReturnType<typeof fixture>['state']) => {
      s.reportBody = approved.replace('New blocking findings: 0', 'New blocking findings: 1');
    },
  ],
  [
    'human decision',
    (s: ReturnType<typeof fixture>['state']) => {
      s.reportBody = approved.replace('`merge`', '`human_decision`');
    },
  ],
  [
    'missing check',
    (s: ReturnType<typeof fixture>['state']) => {
      s.checkNames = ['Centaur final LGTM'];
    },
  ],
  [
    'CI failure',
    (s: ReturnType<typeof fixture>['state']) => {
      s.checkBucket = 'fail';
    },
  ],
  [
    'skipped check',
    (s: ReturnType<typeof fixture>['state']) => {
      s.checkState = 'SKIPPED';
    },
  ],
] as const)('refuses %s drift without admission or mutation', async (_label, change) => {
  const f = fixture();
  change(f.state);
  let admissions = 0;
  const result = await f.adapter
    .merge(
      pins,
      signal(),
      () => {
        admissions++;
      },
      () => {},
    )
    .catch(() => ({ state: 'blocked' }));
  expect(result).toEqual({ state: 'blocked' });
  expect(admissions).toBe(0);
  expect(f.state.mutations).toBe(0);
});
it('preserves refusal across candidate gate changes without invoking admission', async () => {
  const f = fixture();
  expect(await f.adapter.inspect(pins, signal())).toMatchObject({ state: 'ready' });
  f.state.reportBody = approved.replace('`merge`', '`fix`');
  expect(
    await f.adapter.merge(
      pins,
      signal(),
      () => {
        throw new Error('Must not admit');
      },
      () => {},
    ),
  ).toEqual({ state: 'blocked' });
  expect(f.state.mutations).toBe(0);
  f.state.reportBody = approved;
  await expect(
    f.adapter.merge(
      pins,
      signal(),
      () => {
        throw new Error('Current publication hold');
      },
      () => {},
    ),
  ).rejects.toThrow('Current publication hold');
  expect(f.state.mutations).toBe(0);
});
it('observes an original remote merge after adapter restart without issuing a mutation', async () => {
  const f = fixture();
  // External GitHub state only. No admitted/accepted owned receipt is fabricated.
  f.state.merged = true;
  const restarted = new GithubMainPublication(config, f.run, f.dispatchMerge);
  expect(await restarted.inspect(pins, signal())).toEqual({
    state: 'accepted',
    mergeCommit: merge,
    baseHead: main,
    mainHead: merge,
  });
  expect(f.state.mutations).toBe(0);
});
it.each(['wrong parent', 'not contained'] as const)(
  'does not claim accepted main for %s',
  async (reason) => {
    const f = fixture();
    f.state.merged = true;
    if (reason === 'wrong parent') f.state.parent = 'd'.repeat(40);
    else f.state.contained = false;
    const selected =
      reason === 'wrong parent'
        ? { ...pins, contract: undefined, input: { ...pins.input, mainHead: main } }
        : pins;
    expect(await f.adapter.inspect(selected, signal())).toEqual({ state: 'blocked' });
  },
);

it('IDENTITY: reads an original merged PR through retained node identity after repository transfer', async () => {
  const f = fixture();
  f.state.repositoryName = 'new-owner/transferred';
  f.state.merged = true;
  expect(await f.adapter.inspect(pins, signal())).toEqual({
    state: 'accepted',
    mergeCommit: merge,
    baseHead: main,
    mainHead: merge,
  });
  expect(f.state.mutations).toBe(0);
});
it('IDENTITY: derives fresh pins from actual repository and PR response IDs and refuses implicit redirect rebinding', async () => {
  const f = fixture();
  expect(await f.adapter.resolveResource(pins.input, signal())).toEqual(pins.resource);
  f.state.repositoryName = 'new-owner/transferred';
  await expect(f.adapter.resolveResource(pins.input, signal())).rejects.toThrow(/name changed/);
  const current = new GithubMainPublication(
    {
      ...config,
      repository: f.state.repositoryName,
      connectionId: 'rotated',
      capabilityId: 'rotated-main',
    },
    f.run,
    f.dispatchMerge,
  );
  expect(await current.resolveResource(pins.input, signal())).toEqual(pins.resource);
  expect(f.state.mutations).toBe(0);
});
it('IDENTITY: missing external identity cannot create new resource pins', async () => {
  const f = fixture();
  f.state.omitIdentity = true;
  await expect(f.adapter.resolveResource(pins.input, signal())).rejects.toThrow();
  expect(f.state.mutations).toBe(0);
});
it('IDENTITY: recovery uses full-width database identity and preserves original immutable pins', async () => {
  const f = fixture();
  f.state.pullRequestId = 4_904_000_001;
  f.state.merged = true;
  const retained = {
    ...pins,
    resource: { ...pins.resource, pullRequestId: f.state.pullRequestId },
  };
  const before = JSON.stringify(retained);
  expect(await f.adapter.inspect(retained, signal())).toEqual({
    state: 'accepted',
    mergeCommit: merge,
    baseHead: main,
    mainHead: merge,
  });
  expect(JSON.stringify(retained)).toBe(before);
  expect(f.calls.some((c) => c.args.some((a) => a.includes('fullDatabaseId')))).toBe(true);
});
it.each(['repository', 'pull request', 'missing'])(
  'IDENTITY: refuses %s identity drift on retained recovery',
  async (kind) => {
    const f = fixture();
    f.state.merged = true;
    if (kind === 'repository') f.state.repositoryId = 999;
    else if (kind === 'pull request') f.state.pullRequestId = 999;
    else f.state.omitIdentity = true;
    await expect(f.adapter.inspect(pins, signal())).rejects.toThrow();
    expect(f.state.mutations).toBe(0);
  },
);

it('IDENTITY: recovery rechecks main on the retained repository object before accepting name-routed observations', async () => {
  const f = fixture();
  f.state.merged = true;
  f.state.nodeMainHead = 'd'.repeat(40);
  expect(await f.adapter.inspect(pins, signal())).toEqual({ state: 'blocked' });
  expect(f.state.mutations).toBe(0);
});

it('NR-PUB-1: name reuse at the external effect boundary cannot mutate a different repository/PR with the same source', async () => {
  const f = fixture();
  f.state.beforePut = () => {
    f.state.nameReused = true;
    f.state.repositoryName = 'new-owner/original';
  };
  const result = await f.adapter.merge(
    pins,
    signal(),
    () => {},
    () => {},
  );
  expect(f.state.wrongResourceMutations).toBe(0);
  expect(f.state.mutations).toBe(1);
  expect(result).toMatchObject({ state: 'accepted', mergeCommit: merge });
});

it.each([
  [
    'PR node',
    (pr: Record<string, unknown>) => {
      pr.id = 'PR_reused';
    },
  ],
  [
    'PR database ID',
    (pr: Record<string, unknown>) => {
      pr.fullDatabaseId = '999';
    },
  ],
  [
    'repository node',
    (pr: Record<string, unknown>) => {
      pr.repository = { id: 'R_reused', fullDatabaseId: '101' };
    },
  ],
  [
    'repository database ID',
    (pr: Record<string, unknown>) => {
      pr.repository = { id: 'R_original', fullDatabaseId: '999' };
    },
  ],
  [
    'source',
    (pr: Record<string, unknown>) => {
      pr.headRefOid = 'd'.repeat(40);
    },
  ],
  [
    'base branch',
    (pr: Record<string, unknown>) => {
      pr.baseRefName = 'other';
    },
  ],
  [
    'merged state',
    (pr: Record<string, unknown>) => {
      pr.merged = false;
    },
  ],
  [
    'missing commit',
    (pr: Record<string, unknown>) => {
      pr.mergeCommit = null;
    },
  ],
] as const)(
  'NR-PUB-1: rejects a merge response with changed %s before acknowledging it',
  async (_name, change) => {
    const f = fixture();
    f.state.mutationReply = (value) => {
      const reply = value as {
        data: { mergePullRequest: { pullRequest: Record<string, unknown> } };
      };
      change(reply.data.mergePullRequest.pullRequest);
      return reply;
    };
    let acknowledgements = 0;
    await expect(
      f.adapter.merge(
        pins,
        signal(),
        () => {},
        () => {
          acknowledgements++;
        },
      ),
    ).rejects.toThrow();
    expect(acknowledgements).toBe(0);
    expect(f.state.mutations).toBe(1);
  },
);

it('DISPATCH: admission follows asynchronous credential/cwd preparation and precedes its one external effect', async () => {
  const f = fixture();
  let prepared = false;
  let admissions = 0;
  f.state.prepareDispatch = async () => {
    await Promise.resolve();
    prepared = true;
  };
  f.state.beforePut = () => {
    expect(admissions).toBe(1);
  };
  const result = await f.adapter.merge(
    pins,
    signal(),
    () => {
      expect(prepared).toBe(true);
      admissions++;
    },
    () => {},
  );
  expect(result.state).toBe('accepted');
  expect(f.state.mutations).toBe(1);
  expect(admissions).toBe(1);
});
it('DISPATCH: abort during preparation cannot consume admission or reach the external mutation', async () => {
  const f = fixture();
  const controller = new AbortController();
  let admissions = 0;
  f.state.prepareDispatch = async () => {
    await Promise.resolve();
    controller.abort();
  };
  await expect(
    f.adapter.merge(
      pins,
      controller.signal,
      () => {
        admissions++;
      },
      () => {},
    ),
  ).rejects.toThrow();
  expect(admissions).toBe(0);
  expect(f.state.mutations).toBe(0);
});

it('DISPATCH: missing explicit dispatcher is rejected even when a read runner exists', () => {
  const f = fixture();
  // @ts-expect-error Historical two-argument construction is intentionally unavailable.
  expect(() => new GithubMainPublication(config, f.run)).toThrow(/dispatcher required/);
});
it('DISPATCH: a successful-looking response without dispatch admission is rejected before acknowledgement', async () => {
  const f = fixture();
  const adapter = new GithubMainPublication(config, f.run, async () => ({
    stdout: '{}',
    stderr: '',
  }));
  let admissions = 0,
    acknowledgements = 0;
  await expect(
    adapter.merge(
      pins,
      signal(),
      () => {
        admissions++;
      },
      () => {
        acknowledgements++;
      },
    ),
  ).rejects.toThrow(/did not admit/);
  expect(admissions).toBe(0);
  expect(acknowledgements).toBe(0);
  expect(f.state.mutations).toBe(0);
});
it('DISPATCH: the admission callback cannot be reused after a refused first attempt', async () => {
  const f = fixture();
  let attempts = 0;
  const adapter = new GithubMainPublication(
    config,
    f.run,
    async (_command, _args, _signal, admit) => {
      expect(() => admit()).toThrow('Real admission refused');
      expect(() => admit()).toThrow(/one-use/);
      return { stdout: '{}', stderr: '' };
    },
  );
  await expect(
    adapter.merge(
      pins,
      signal(),
      () => {
        attempts++;
        throw Error('Real admission refused');
      },
      () => {},
    ),
  ).rejects.toThrow(/did not admit/);
  expect(attempts).toBe(1);
  expect(f.state.mutations).toBe(0);
});
