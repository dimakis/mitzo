import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  createWorkspaceRuntimeClient,
  workspaceRuntimeConfigured,
} from '../workspace-runtime-client.js';

let root: string;
let enrollment: string;
let release: string;
let briefings: string;
function git(...args: string[]) {
  return execFileSync('git', ['-C', release, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function privateJson(path: string, data: unknown) {
  writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
}
function script(body: string) {
  writeFileSync(
    join(release, 'run-runtime.py'),
    `import json, sys, os, time\nargs=sys.argv\nop=args[args.index('--operation')+1]\n${body}\n`,
  );
  git('add', '.');
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture',
  );
  git('checkout', '--detach');
  const current = JSON.parse(readFileSync(enrollment, 'utf8'));
  privateJson(enrollment, { ...current, releaseCommit: git('rev-parse', 'HEAD') });
}
const fixtureDescription =
  "if op == 'runtime.describe': print(json.dumps({'protocol':'workspace-runtime-v1','version':'0.1.0','operations':['calendar.read','briefings.latest']}))\n";
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'mitzo-runtime-')));
  release = join(root, 'release');
  briefings = join(root, 'briefings');
  mkdirSync(release);
  mkdirSync(briefings);
  git('init', '-q');
  enrollment = join(root, 'enrollment.json');
  const config = join(root, 'config.json');
  privateJson(config, {
    configPath: join(root, 'telos.yaml'),
    relationshipsPath: join(root, 'relationships.yaml'),
    dataRoot: join(root, 'data'),
    briefingsRoot: briefings,
    inboxRoot: join(root, 'inbox'),
    jiraLibPath: join(root, 'jira'),
    gwsExecutable: '/usr/bin/true',
    jiraLibSha256: '0'.repeat(64),
    contexginUrl: 'http://127.0.0.1:4195',
  });
  privateJson(enrollment, {
    kind: 'workspace-runtime-v1',
    release,
    releaseCommit: '0'.repeat(40),
    python: execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8',
    }).trim(),
    config,
    briefingsRoot: briefings,
  });
  script(
    fixtureDescription +
      "elif op == 'calendar.read': print(json.dumps({'startDate':'2026-10-10','endDate':'2026-10-12','events':[],'sprints':[]}))\nelse: print('null')",
  );
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('enrolled workspace runtime', () => {
  it('executes the pinned separate process and validates calendar data', async () => {
    expect(workspaceRuntimeConfigured({ MITZO_WORKSPACE_RUNTIME_CONFIG: enrollment })).toBe(true);
    expect(workspaceRuntimeConfigured({})).toBe(false);
    const client = createWorkspaceRuntimeClient(enrollment);
    await expect(client.calendar({ date: '2026-10-10', days: 3 })).resolves.toEqual({
      startDate: '2026-10-10',
      endDate: '2026-10-12',
      events: [],
      sprints: [],
    });
    await expect(client.latestBriefing({ date: '2026-10-10' })).resolves.toBeNull();
  });
  it('maps only a physical matching briefing basename into the enrolled root', async () => {
    const name = 'morning_2026-10-10_0830.md';
    writeFileSync(join(briefings, name), 'report');
    script(
      fixtureDescription +
        `else: print(json.dumps({'filename':'${name}','artifact':'${name}','date':'2026-10-10','generatedAt':'2026-10-10T08:30:00Z'}))`,
    );
    await expect(
      createWorkspaceRuntimeClient(enrollment).latestBriefing({ date: '2026-10-10' }),
    ).resolves.toEqual({
      filename: name,
      date: '2026-10-10',
      generatedAt: '2026-10-10T08:30:00Z',
      path: join(briefings, name),
    });
    rmSync(join(briefings, name));
    symlinkSync(join(root, 'config.json'), join(briefings, name));
    await expect(
      createWorkspaceRuntimeClient(enrollment).latestBriefing({ date: '2026-10-10' }),
    ).rejects.toThrow();
  });
  it('rejects changed source without fallback', async () => {
    writeFileSync(join(release, 'run-runtime.py'), 'raise RuntimeError("dirty")');
    await expect(
      createWorkspaceRuntimeClient(enrollment).calendar({ date: '2026-10-10', days: 3 }),
    ).rejects.toThrow();
  });
  it('rejects another commit, attached branches and symlinked launchers', async () => {
    const current = JSON.parse(readFileSync(enrollment, 'utf8'));
    privateJson(enrollment, { ...current, releaseCommit: '0'.repeat(40) });
    await expect(
      createWorkspaceRuntimeClient(enrollment).latestBriefing({ date: '2026-10-10' }),
    ).rejects.toThrow();
    privateJson(enrollment, current);
    git('checkout', '-qb', 'mutable');
    await expect(
      createWorkspaceRuntimeClient(enrollment).latestBriefing({ date: '2026-10-10' }),
    ).rejects.toThrow();
    git('checkout', '--detach');
    rmSync(join(release, 'run-runtime.py'));
    symlinkSync(join(root, 'config.json'), join(release, 'run-runtime.py'));
    expect(() => createWorkspaceRuntimeClient(enrollment)).toThrow();
  });
  it.each(['../config.json', '/private/config.json', 'morning_2026-10-11_0830.md'])(
    'rejects unsafe or mismatched briefing locator %s',
    async (artifact) => {
      script(
        fixtureDescription +
          `else: print(json.dumps({'filename':${JSON.stringify(artifact)},'artifact':${JSON.stringify(artifact)},'date':'2026-10-10','generatedAt':'2026-10-10T08:00:00Z'}))`,
      );
      await expect(
        createWorkspaceRuntimeClient(enrollment).latestBriefing({ date: '2026-10-10' }),
      ).rejects.toThrow();
    },
  );
  it('detects tracked edits hidden by index flags and ignored Python injection', async () => {
    git('update-index', '--assume-unchanged', 'run-runtime.py');
    writeFileSync(
      join(release, 'run-runtime.py'),
      readFileSync(join(release, 'run-runtime.py'), 'utf8') + '\n# hidden tracked edit\n',
    );
    await expect(
      createWorkspaceRuntimeClient(enrollment).latestBriefing({ date: '2026-10-10' }),
    ).rejects.toThrow();
    git('update-index', '--no-assume-unchanged', 'run-runtime.py');
    git('checkout', '--', 'run-runtime.py');
    writeFileSync(join(release, '.git', 'info', 'exclude'), 'src/\n');
    mkdirSync(join(release, 'src', 'calendar'), { recursive: true });
    writeFileSync(
      join(release, 'src', 'calendar', '__init__.py'),
      'raise RuntimeError("injected")',
    );
    await expect(
      createWorkspaceRuntimeClient(enrollment).latestBriefing({ date: '2026-10-10' }),
    ).rejects.toThrow();
  });
  it('rejects hardlinked operator files rather than trusting one pathname', () => {
    const configPath = JSON.parse(readFileSync(enrollment, 'utf8')).config;
    linkSync(configPath, join(root, 'config-alias.json'));
    expect(() => createWorkspaceRuntimeClient(enrollment)).toThrow();
    rmSync(join(root, 'config-alias.json'));
    linkSync(enrollment, join(root, 'enrollment-alias.json'));
    expect(() => createWorkspaceRuntimeClient(enrollment)).toThrow();
  });
  it('rejects private file permission loss and unknown enrollment fields', async () => {
    chmodSync(enrollment, 0o644);
    expect(() => createWorkspaceRuntimeClient(enrollment)).toThrow();
    chmodSync(enrollment, 0o600);
    privateJson(enrollment, {
      ...JSON.parse(readFileSync(enrollment, 'utf8')),
      command: 'anything',
    });
    expect(() => createWorkspaceRuntimeClient(enrollment)).toThrow();
  });
  it('preserves documented Google Workspace authentication settings without forwarding startup controls', async () => {
    script(
      fixtureDescription +
        "else:\n assert os.environ.get('GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND') == 'file'\n assert os.environ.get('GOOGLE_WORKSPACE_CLI_CLIENT_ID') == 'synthetic-client-id'\n assert os.environ.get('GOOGLE_WORKSPACE_CLI_CLIENT_SECRET') == 'synthetic-client-secret'\n assert 'PYTHONPATH' not in os.environ and 'NODE_OPTIONS' not in os.environ and 'EXTRA_SECRET' not in os.environ\n print(json.dumps({'startDate':'2026-10-10','endDate':'2026-10-12','events':[],'sprints':[]}))",
    );
    const client = createWorkspaceRuntimeClient(enrollment, {
      env: {
        HOME: root,
        PATH: '/usr/bin:/bin',
        GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: 'file',
        GOOGLE_WORKSPACE_CLI_CLIENT_ID: 'synthetic-client-id',
        GOOGLE_WORKSPACE_CLI_CLIENT_SECRET: 'synthetic-client-secret',
        PYTHONPATH: '/evil',
        NODE_OPTIONS: '--require evil',
        EXTRA_SECRET: 'not-forwarded',
      },
    });
    await expect(client.calendar({ date: '2026-10-10', days: 3 })).resolves.toHaveProperty(
      'events',
      [],
    );
  });
  it('does not inherit arbitrary environment or startup controls', async () => {
    script(
      fixtureDescription +
        "else:\n assert 'PYTHONPATH' not in os.environ and 'NODE_OPTIONS' not in os.environ and 'EXTRA_SECRET' not in os.environ\n assert os.environ.get('JIRA_API_TOKEN') == 'test-token'\n print(json.dumps({'startDate':'2026-10-10','endDate':'2026-10-12','events':[],'sprints':[]}))",
    );
    const client = createWorkspaceRuntimeClient(enrollment, {
      env: {
        HOME: root,
        PATH: '/usr/bin:/bin',
        JIRA_API_TOKEN: 'test-token',
        PYTHONPATH: '/evil',
        NODE_OPTIONS: '--require evil',
        EXTRA_SECRET: 'do-not-inherit',
      },
    });
    await expect(client.calendar({ date: '2026-10-10', days: 3 })).resolves.toHaveProperty(
      'events',
      [],
    );
  });
  it('rejects unsupported protocol, malformed output and date/operation mismatches', async () => {
    script("print('{}')");
    await expect(
      createWorkspaceRuntimeClient(enrollment).calendar({ date: '2026-10-10', days: 3 }),
    ).rejects.toThrow();
    await expect(
      createWorkspaceRuntimeClient(enrollment).calendar({ date: '../escape', days: 3 }),
    ).rejects.toThrow();
    await expect(
      createWorkspaceRuntimeClient(enrollment).calendar({ date: '2026-02-30', days: 3 }),
    ).rejects.toThrow();
  });
  it('terminates owned provider descendants on cancellation', async () => {
    const pidPath = join(root, 'provider.pid');
    script(
      fixtureDescription +
        `else:
 import subprocess
 open(${JSON.stringify(pidPath)}, 'w').close()
 time.sleep(0.1)
 child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
 open(${JSON.stringify(pidPath)}, 'w').write(str(child.pid))
 time.sleep(60)`,
    );
    const controller = new AbortController();
    const call = createWorkspaceRuntimeClient(enrollment, { timeoutMs: 3000 }).latestBriefing(
      { date: '2026-10-10' },
      controller.signal,
    );
    // Observe cancellation even if readiness fails; assert the original call below.
    void call.catch(() => {});
    let pid: number | undefined;
    try {
      for (let count = 0; count < 100; count++) {
        try {
          const candidate = Number(readFileSync(pidPath, 'utf8'));
          if (Number.isInteger(candidate) && candidate > 0) {
            pid = candidate;
            break;
          }
        } catch {
          /* The provider has not created its marker yet. */
        }
        await new Promise((done) => setTimeout(done, 20));
      }
      expect(pid).toBeGreaterThan(0);
      controller.abort();
      await expect(call).rejects.toThrow();
      await new Promise((done) => setTimeout(done, 100));
      expect(() => process.kill(pid!, 0)).toThrow();
    } finally {
      controller.abort();
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* Already terminated. */
        }
      }
    }
  });
  it('rejects timeout, caller cancellation and oversized process output', async () => {
    script(fixtureDescription + "else: time.sleep(2); print('null')");
    await expect(
      createWorkspaceRuntimeClient(enrollment, { timeoutMs: 100 }).latestBriefing({
        date: '2026-10-10',
      }),
    ).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(
      createWorkspaceRuntimeClient(enrollment).latestBriefing(
        { date: '2026-10-10' },
        controller.signal,
      ),
    ).rejects.toThrow();
    script(fixtureDescription + "else: print('x'*100000)");
    await expect(
      createWorkspaceRuntimeClient(enrollment, { maxBytes: 1024 }).latestBriefing({
        date: '2026-10-10',
      }),
    ).rejects.toThrow();
  });
});
