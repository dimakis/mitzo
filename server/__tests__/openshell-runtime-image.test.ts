import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const builder = resolve('docs/spikes/openshell-codex/build-mgmt-runtime.sh');
const initializer = resolve('docs/spikes/openshell-codex/initialize-mitzo-workspace');
const apiRunner = resolve('docs/spikes/openshell-codex/run-mitzo-app-server');
const subscriptionRunner = resolve('docs/spikes/openshell-codex/run-mitzo-subscription-app-server');
const notebookRunner = resolve('docs/spikes/openshell-codex/run-mgmt-notebook');
const chatSession = resolve('server/codex-chat-session.ts');

function rejectedBase(base: string): string {
  try {
    execFileSync(builder, ['/unused/mgmt', 'localhost/mitzo:test', base], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    throw new Error('builder unexpectedly accepted a mutable base image');
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? error);
  }
}

function notebookRunnerForTest(root: string, python: string): string {
  const environment = join(root, 'mgmt-jira.env');
  const runner = join(root, 'run-mgmt-notebook');
  writeFileSync(environment, 'MGMT_JIRA_PYTHONPATH=/image-fixed/site-packages\n');
  writeFileSync(
    runner,
    readFileSync(notebookRunner, 'utf8')
      .replace('/etc/mitzo-mgmt-jira.env', environment)
      .replace('/usr/bin/python3', python),
  );
  chmodSync(runner, 0o700);
  return runner;
}

describe('OpenShell runtime image builder', () => {
  it('installs the vendored Jira notebook runtime from its checked-in frozen lock', () => {
    const dockerfile = readFileSync(
      resolve('docs/spikes/openshell-codex/Dockerfile.mgmt-runtime'),
      'utf8',
    );
    const build = readFileSync(builder, 'utf8');
    expect(dockerfile).toContain(
      'COPY jira_process/pyproject.toml jira_process/uv.lock /opt/mgmt-jira-runtime/',
    );
    expect(dockerfile).toContain(
      'UV_PROJECT_ENVIRONMENT=/opt/mgmt-jira-venv uv sync --frozen --no-dev --no-install-project',
    );
    expect(dockerfile).toContain(
      'find /opt/mgmt-jira-venv/lib -mindepth 2 -maxdepth 2 -type d -name site-packages -print',
    );
    expect(dockerfile).toContain('MGMT_JIRA_PYTHONPATH=%s');
    expect(dockerfile).toContain('/usr/local/share/jupyter/kernels/mgmt-jira/kernel.json');
    expect(dockerfile).toContain('"argv": ["/usr/bin/python3", "-m", "ipykernel_launcher"');
    expect(dockerfile).toContain('\\"env\\": {\\"PYTHONPATH\\": \\"$site_packages\\"}');
    expect(dockerfile).not.toContain('ENV PATH="/opt/mgmt-jira-venv/bin:${PATH}"');
    expect(build).toContain('test -f "$mgmt_repo/jira_process/pyproject.toml"');
    expect(build).toContain('test -f "$mgmt_repo/jira_process/uv.lock"');
    expect(build).toContain('cp "$mgmt_repo/jira_process/pyproject.toml"');
    expect(build).toContain('cp "$mgmt_repo/jira_process/uv.lock"');
    expect(build).not.toContain('uv lock');
  });

  it('executes a notebook copy under reports without modifying its mounted source', () => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-jira-notebook-'));
    const workspace = join(root, 'mgmt');
    const runtime = join(workspace, 'jira_process');
    const bin = join(root, 'bin');
    const capture = join(root, 'python-args');
    const source = join(runtime, 'dashboards', 'smoke.ipynb');
    const outputRoot = join(runtime, 'reports', 'notebook-runs');
    const sourceContents = '{"cells":[]}\n';
    try {
      mkdirSync(join(runtime, 'dashboards'), { recursive: true });
      mkdirSync(bin);
      writeFileSync(source, sourceContents);
      writeFileSync(
        join(bin, 'python'),
        `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$CAPTURE"
printf '%s\\n' "$PYTHONPATH" > "$PYTHONPATH_CAPTURE"
for ((index=1; index <= $#; index++)); do
  value="\${!index}"
  case "$value" in
    --output-dir) next=$((index + 1)); output_dir="\${!next}" ;;
    --output) next=$((index + 1)); output_name="\${!next}" ;;
  esac
done
mkdir -p "$output_dir" "$IPYTHONDIR" "$JUPYTER_RUNTIME_DIR"
printf 'executed\\n' > "$output_dir/$output_name"
`,
      );
      chmodSync(join(bin, 'python'), 0o700);
      const runner = notebookRunnerForTest(root, join(bin, 'python'));

      const canonicalRuntime = realpathSync(runtime);
      const canonicalOutputRoot = join(canonicalRuntime, 'reports', 'notebook-runs');
      const canonicalSource = join(canonicalRuntime, 'dashboards', 'smoke.ipynb');

      const output = execFileSync('bash', [runner, 'dashboards/smoke.ipynb'], {
        env: {
          ...process.env,
          MITZO_MGMT_WORKDIR: workspace,
          MITZO_MGMT_NOTEBOOK_OUTPUT_DIR: outputRoot,
          MITZO_MGMT_NOTEBOOK_RUN_ID: 'smoke-run',
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          CAPTURE: capture,
          PYTHONPATH_CAPTURE: join(root, 'pythonpath'),
          PYTHONPATH: '/caller-controlled/site-packages',
          TMPDIR: root,
        },
        encoding: 'utf8',
      });

      expect(readFileSync(capture, 'utf8').trim().split('\n')).toEqual([
        '-m',
        'jupyter',
        'nbconvert',
        '--to',
        'notebook',
        '--execute',
        '--ExecutePreprocessor.kernel_name=mgmt-jira',
        '--output-dir',
        join(canonicalOutputRoot, 'smoke-run'),
        '--output',
        'smoke.executed.ipynb',
        canonicalSource,
      ]);
      expect(readFileSync(join(root, 'pythonpath'), 'utf8')).toBe('/image-fixed/site-packages\n');
      expect(readFileSync(source, 'utf8')).toBe(sourceContents);
      expect(output.trim()).toBe(join(canonicalOutputRoot, 'smoke-run', 'smoke.executed.ipynb'));
      expect(readFileSync(output.trim(), 'utf8')).toBe('executed\n');
      expect(readdirSync(root).filter((name) => name.startsWith('mitzo-mgmt-jupyter.'))).toEqual(
        [],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows concurrent first notebook runs to create shared report directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-jira-notebook-concurrent-'));
    const workspace = join(root, 'mgmt');
    const runtime = join(workspace, 'jira_process');
    const bin = join(root, 'bin');
    const barrier = join(root, 'mkdir-barrier');
    try {
      mkdirSync(join(runtime, 'dashboards'), { recursive: true });
      mkdirSync(bin);
      writeFileSync(join(runtime, 'dashboards', 'smoke.ipynb'), '{}\n');
      writeFileSync(join(bin, 'python'), '#!/usr/bin/env bash\nexit 0\n');
      writeFileSync(
        join(bin, 'mkdir'),
        `#!/usr/bin/env bash
target="\${!#}"
if [[ "$target" == "$REPORTS_DIR" ]]; then
  /bin/mkdir -p "$BARRIER"
  touch "$BARRIER/$$"
  for ((attempt = 0; attempt < 200; attempt++)); do
    [[ "$(find "$BARRIER" -type f | wc -l | tr -d ' ')" == 2 ]] && break
    sleep 0.01
  done
fi
exec /bin/mkdir "$@"
`,
      );
      chmodSync(join(bin, 'python'), 0o700);
      chmodSync(join(bin, 'mkdir'), 0o700);
      const runner = notebookRunnerForTest(root, join(bin, 'python'));

      const run = (runId: string) =>
        new Promise<number | null>((resolveRun) => {
          const child = spawn('bash', [runner, 'dashboards/smoke.ipynb'], {
            env: {
              ...process.env,
              MITZO_MGMT_WORKDIR: workspace,
              MITZO_MGMT_NOTEBOOK_RUN_ID: runId,
              PATH: `${bin}:${process.env.PATH ?? ''}`,
              BARRIER: barrier,
              REPORTS_DIR: join(realpathSync(runtime), 'reports'),
              TMPDIR: root,
            },
            stdio: 'ignore',
          });
          child.on('close', resolveRun);
        });

      expect(await Promise.all([run('first'), run('second')])).toEqual([0, 0]);
      expect(existsSync(join(runtime, 'reports', 'notebook-runs', 'first'))).toBe(true);
      expect(existsSync(join(runtime, 'reports', 'notebook-runs', 'second'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps managed Jira guidance compatible with reused non-runtime images', () => {
    const source = readFileSync(chatSession, 'utf8');
    expect(source).toContain('provider-approved /usr/bin/python3 or curl');
    expect(source).not.toContain('Use /opt/mgmt-jira-venv/bin/python or curl');
  });

  it('uses system Python and a fixed image kernel for notebook execution', () => {
    const source = readFileSync(notebookRunner, 'utf8');
    expect(source).toContain('runtime_environment="/etc/mitzo-mgmt-jira.env"');
    expect(source).toContain('export PYTHONPATH="$MGMT_JIRA_PYTHONPATH"');
    expect(source).toContain('/usr/bin/python3 -m jupyter nbconvert');
    expect(source).toContain('--ExecutePreprocessor.kernel_name=mgmt-jira');
    expect(source).not.toContain('python -m jupyter nbconvert');
  });

  it('rejects notebook paths outside the mounted Jira runtime', () => {
    try {
      execFileSync('bash', [notebookRunner, '../outside.ipynb'], {
        env: { ...process.env, MITZO_MGMT_WORKDIR: '/unused' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      throw new Error('runner unexpectedly accepted a traversal path');
    } catch (error) {
      expect(String((error as { stderr?: string }).stderr ?? error)).toContain(
        'relative .ipynb path',
      );
    }
  });

  it.each(['source', 'reports'] as const)(
    'rejects a symlinked Jira runtime %s path that resolves outside the mount',
    (kind) => {
      const root = mkdtempSync(join(tmpdir(), 'mitzo-jira-notebook-symlink-'));
      const workspace = join(root, 'mgmt');
      const runtime = join(workspace, 'jira_process');
      const outside = join(root, 'outside');
      try {
        mkdirSync(join(runtime, 'dashboards'), { recursive: true });
        mkdirSync(outside);
        if (kind === 'source') {
          writeFileSync(join(outside, 'smoke.ipynb'), '{}\n');
          symlinkSync(outside, join(runtime, 'dashboards', 'linked'), 'dir');
        } else {
          writeFileSync(join(runtime, 'dashboards', 'smoke.ipynb'), '{}\n');
          symlinkSync(outside, join(runtime, 'reports'), 'dir');
        }

        try {
          execFileSync(
            'bash',
            [
              notebookRunner,
              kind === 'source' ? 'dashboards/linked/smoke.ipynb' : 'dashboards/smoke.ipynb',
            ],
            {
              env: { ...process.env, MITZO_MGMT_WORKDIR: workspace },
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );
          throw new Error('runner unexpectedly accepted an escaping symlink');
        } catch (error) {
          expect(String((error as { stderr?: string }).stderr ?? error)).toMatch(
            /must resolve inside|must not resolve outside/,
          );
        }
        expect(existsSync(join(outside, 'notebook-runs'))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('disables Codex request compression in every OpenShell app-server launcher', () => {
    for (const runner of [apiRunner, subscriptionRunner])
      expect(readFileSync(runner, 'utf8')).toContain('features.enable_request_compression=false');
  });
  it.each([
    'ghcr.io/nvidia/openshell-community/sandboxes/base:latest',
    'ghcr.io/nvidia/openshell-community/sandboxes/base:0.0.116',
    'sha256:bcf4897ab8f95ec875847998297da98d16a44c8741c62c738d917f0eb8d35097',
    'ghcr.io/nvidia/openshell-community/sandboxes/base@sha256:ab-not-a-digest',
    `ghcr.io/nvidia/openshell-community/sandboxes/base@sha256:${'a'.repeat(63)}`,
    `ghcr.io/nvidia/openshell-community/sandboxes/base@sha256:${'a'.repeat(65)}`,
  ])('rejects mutable or registry-less base reference %s', (base) => {
    expect(rejectedBase(base)).toContain('base image must use an immutable @sha256 digest');
  });

  it.each(['localhost/mitzo-mgmt-runtime:latest', 'localhost/mitzo-mgmt-runtime:dev'])(
    'rejects reserved mutable output tag %s',
    (tag) => {
      expect(() =>
        execFileSync(
          builder,
          [
            '/unused/mgmt',
            tag,
            'ghcr.io/nvidia/openshell-community/sandboxes/base@sha256:04dd51f785ae52557ac53d4b12b3a0611a7347e5b8738e6278203465e6fb726e',
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        ),
      ).toThrow(/output tag must be unique/);
    },
  );

  it.each(['localhost/mitzo-mgmt-runtime', 'localhost:5000/mitzo-mgmt-runtime'])(
    'rejects output image without an explicit tag %s',
    (tag) => {
      expect(() =>
        execFileSync(
          builder,
          [
            '/unused/mgmt',
            tag,
            'ghcr.io/nvidia/openshell-community/sandboxes/base@sha256:04dd51f785ae52557ac53d4b12b3a0611a7347e5b8738e6278203465e6fb726e',
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        ),
      ).toThrow(/explicit unique tag/);
    },
  );

  it('initializes an idempotent portable Git baseline inside the sandbox workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'mitzo-sandbox-workspace-'));
    const workspace = join(root, 'sandbox', 'workspaces', 'mgmt');
    try {
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, 'fixture.txt'), 'seed\n');

      const env = { ...process.env, MITZO_WORKSPACE_ROOT: join(root, 'sandbox', 'workspaces') };
      execFileSync(initializer, [workspace], { env });
      execFileSync(initializer, [workspace], { env });

      expect(
        execFileSync('git', ['-C', workspace, 'status', '--porcelain'], { encoding: 'utf8' }),
      ).toBe('');
      expect(
        execFileSync('git', ['-C', workspace, 'rev-list', '--count', 'HEAD'], {
          encoding: 'utf8',
        }),
      ).toBe('1\n');
      expect(execFileSync('git', ['-C', workspace, 'remote'], { encoding: 'utf8' })).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['traversal', 'symlink'] as const)(
    'rejects a %s path that resolves outside the configured workspace root',
    (kind) => {
      const root = mkdtempSync(join(tmpdir(), 'mitzo-sandbox-escape-'));
      const workspaceRoot = join(root, 'sandbox', 'workspaces');
      const outside = join(root, 'sandbox', 'other');
      try {
        mkdirSync(workspaceRoot, { recursive: true });
        mkdirSync(outside, { recursive: true });
        const candidate =
          kind === 'traversal'
            ? join(workspaceRoot, '..', 'other')
            : join(workspaceRoot, 'outside-link');
        if (kind === 'symlink') symlinkSync(outside, candidate);

        expect(() =>
          execFileSync(initializer, [candidate], {
            env: { ...process.env, MITZO_WORKSPACE_ROOT: workspaceRoot },
            stdio: ['ignore', 'pipe', 'pipe'],
          }),
        ).toThrow(/workspace must be inside/);
        expect(existsSync(join(outside, '.git'))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
