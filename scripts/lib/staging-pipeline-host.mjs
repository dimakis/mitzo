import process from 'node:process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { existsSync, readFileSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { assessStagingResources, STAGING_RESOURCE_BUDGET } from './staging-resource-budget.mjs';

const sha = /^[a-f0-9]{40}$/;
/** Never pass inherited provider configuration into a controller/build. GitHub
 * uses the operator's existing CLI authorization only for public source reads. */
export function runStagingHostCommand(
  program,
  args,
  { heapMiB = 1024, timeout = 30000, pipelineToken } = {},
) {
  const p = spawnSync(program, args, {
    env: {
      PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: homedir(),
      TMPDIR: '/private/tmp',
      LC_ALL: 'C',
      GIT_TERMINAL_PROMPT: '0',
      NODE_OPTIONS: `--max-old-space-size=${heapMiB}`,
      npm_config_jobs: '2',
      ...(pipelineToken ? { MITZO_STAGING_PIPELINE_TOKEN: pipelineToken } : {}),
    },
    encoding: 'utf8',
    timeout,
    maxBuffer: 1048576,
  });
  if (p.status !== 0 || p.signal || p.error)
    throw Object.assign(Error('Bounded staging host command refused or uncertain'), {
      terminalRefusal: Number.isInteger(p.status) && p.status !== 0 && !p.signal && !p.error,
    });
  return p.stdout.trim();
}
export function parseMacStagingResources({ pressure, free, swap, disk, usage, vm }) {
  const available = disk.trim().split('\n').at(-1)?.trim().split(/\s+/)[3];
  const swapMatch = swap.match(/\bused = ([\d.]+)([MG])/);
  const percent = free.match(/System-wide memory free percentage: (\d+)%/);
  const rows = usage.trim().split('\n');
  if (
    !/^[124]$/.test(pressure.trim()) ||
    !percent ||
    !swapMatch ||
    !/^\d+$/.test(available ?? '') ||
    !rows.length ||
    rows.some((r) => !/^\d+\s+\//.test(r))
  )
    throw Error('Host resource observation unavailable');
  const observation = {
    pressureLevel: Number(pressure.trim()),
    memoryFreePercent: Number(percent[1]),
    swapUsedMiB: Number(swapMatch[1]) * (swapMatch[2] === 'G' ? 1024 : 1),
    diskFreeGiB: Number(available) / 1048576,
    stagingGiB: rows.reduce((n, r) => n + Number(r.split(/\s+/)[0]) / 1048576, 0),
    vmMemoryMiB: vm.Resources.Memory,
    vmCpus: vm.Resources.CPUs,
  };
  if (Object.values(observation).some((v) => !Number.isFinite(v) || v < 0))
    throw Error('Host resource observation unavailable');
  return observation;
}
export function observeMacStagingResources(
  root = join(homedir(), '.local/share/mitzo-staging'),
  run = runStagingHostCommand,
) {
  if (process.platform !== 'darwin') throw Error('macOS host resource adapter required');
  const allocations = join(root, 'symposium/allocations');
  const allocationParent = lstatSync(allocations, { throwIfNoEntry: false });
  if (
    allocationParent &&
    (!allocationParent.isDirectory() ||
      allocationParent.isSymbolicLink() ||
      realpathSync(allocations) !== allocations ||
      readdirSync(allocations).length !== 0)
  )
    throw Error(
      'Fresh native allocation requires resource observations from its actual original VM owner; legacy VM absence cannot qualify zero VM use',
    );
  const archive = root + '-quarantine';
  const vmPath = join(
    root,
    'symposium/home/.config/containers/podman/machine/applehv/mitzo-symposium-staging.json',
  );
  const vm = existsSync(vmPath)
    ? JSON.parse(readFileSync(vmPath, 'utf8'))
    : { Resources: { Memory: 0, CPUs: 0 } };
  return parseMacStagingResources({
    pressure: run('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']),
    free: run('/usr/bin/memory_pressure', ['-Q']),
    swap: run('/usr/sbin/sysctl', ['vm.swapusage']),
    disk: run('/bin/df', ['-kP', root]),
    usage: run('/usr/bin/du', ['-sk', root, ...(existsSync(archive) ? [archive] : [])]),
    vm,
  });
}
export function createStagingPipelineEffects({
  root = join(homedir(), '.local/share/mitzo-staging'),
  run = runStagingHostCommand,
  fetch = globalThis.fetch,
} = {}) {
  const controller = join(root, 'bin/mitzo-staging');
  // run-next has already verified this checkout is clean exact accepted main.
  // Apply independently compares its controller bytes with the candidate.
  const acceptedController = fileURLToPath(new URL('../staging.mjs', import.meta.url));
  const mutate = (args) => run(process.execPath, [acceptedController, ...args], opts);
  const opts = { heapMiB: STAGING_RESOURCE_BUDGET.buildHeapMiB, timeout: 180000 };
  const exact = (target, current) => {
    if (!sha.test(target) || (current && !sha.test(current)))
      throw Error('Exact staging source required');
  };
  const check = async () => {
    const r = JSON.parse(run(controller, ['check'], { timeout: 30000 }));
    if (typeof r.safe !== 'boolean' || !sha.test(r.expected))
      throw Error('Canonical stage observation unavailable');
    return r;
  };
  return {
    authorize: (token) => {
      opts.pipelineToken = JSON.stringify(token);
    },
    resources: async (growth) =>
      assessStagingResources(observeMacStagingResources(root, run), growth),
    baseline: async (origin) => {
      exact(origin);
      const { sha: tip } = JSON.parse(run('gh', ['api', 'repos/dimakis/mitzo/commits/main']));
      exact(tip);
      if (tip === origin) return tip;
      const comparison = JSON.parse(
        run('gh', ['api', `repos/dimakis/mitzo/compare/${origin}...${tip}`]),
      );
      if (comparison.status !== 'ahead' || comparison.base_commit?.sha !== origin)
        throw Error('Requested source is outside accepted main');
      return tip;
    },
    check,
    prepared: async (target) => {
      exact(target);
      const result = JSON.parse(mutate(['prepare', '--commit', target, '--check-only']));
      if (result.source !== target) throw Error('Candidate validation source changed');
      if (
        result.prepared === false &&
        result.reused === undefined &&
        Number.isFinite(result.growthGiB) &&
        result.growthGiB >= 2
      )
        return { reused: false, growthGiB: result.growthGiB };
      if (typeof result.prepared === 'string' && result.reused === true)
        return { reused: true, growthGiB: 0 };
      throw Error('Canonical candidate validation unavailable');
    },
    prepare: async (target) => {
      exact(target);
      try {
        mutate(['prepare', '--commit', target]);
      } catch (error) {
        if (error.terminalRefusal === true) error.safePreparationRefusal = true;
        throw error;
      }
    },
    plan: async (target, current) => {
      exact(target, current);
      mutate(['deploy', '--commit', target, '--expected-current', current]);
    },
    deploy: async (target, current) => {
      exact(target, current);
      mutate(['deploy', '--commit', target, '--expected-current', current, '--apply']);
    },
    test: async (suite, target) => {
      exact(target);
      if (suite !== 'http-readiness')
        throw Error('Suite needs separately reviewed staging enrollment');
      // GET only: no provider, session, fixture creation, inference or cleanup effects.
      try {
        const r = await fetch('http://mitzo-staging.localhost:3190/', {
          redirect: 'error',
          signal: globalThis.AbortSignal.timeout(5000),
        });
        await r.body?.cancel();
        return { outcome: r.ok ? 'passed' : 'failed', cleanupConfirmed: true };
      } catch {
        return { outcome: 'failed', cleanupConfirmed: true };
      }
    },
  };
}
