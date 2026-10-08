#!/usr/bin/env node
import process from 'node:process';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectStore, removeImage } from './lib/podman-storage-host.mjs';
import { planImages, applyImages, digest } from './lib/podman-storage-policy.mjs';
import {
  maintenanceHome,
  withStoreLock,
  readState,
  readJson,
  writeJson,
  appendAudit,
  enrollStore,
  storeKey,
} from './lib/podman-storage-maintainer.mjs';

const usage =
  'Usage: node scripts/podman-storage.mjs status|plan|apply|enroll --selection FILE [--output PLAN | --plan PLAN | --reviewed ENROLLMENT]';
export async function runStorageCommand(
  argv,
  { home = maintenanceHome(), collect = collectStore, remove = removeImage, signal } = {},
) {
  const [command, ...args] = argv;
  const allowed = { status: [], plan: ['--output'], apply: ['--plan'], enroll: ['--reviewed'] };
  if (!Object.hasOwn(allowed, command) || args.length % 2) throw Error(usage);
  const options = {};
  for (let n = 0; n < args.length; n += 2) {
    const flag = args[n];
    if (
      !['--selection', ...allowed[command]].includes(flag) ||
      options[flag] ||
      !args[n + 1] ||
      args[n + 1].startsWith('--')
    )
      throw Error(usage);
    options[flag] = resolve(args[n + 1]);
  }
  if (!options['--selection'] || allowed[command].some((flag) => !options[flag]))
    throw Error(usage);
  const selection = await readJson(options['--selection']);
  const initial = await collect(selection, { signal });
  if (!initial.store) {
    if (command !== 'status')
      throw Error(`Selected store unavailable: ${initial.blockers.join('; ')}`);
    return { collection: initial, plan: planImages(initial), lastRun: null };
  }
  const store = initial.store;
  const snapshot = async () => {
    signal?.throwIfAborted();
    const before = await readState(home, store);
    const s = await collect(selection, { enrollment: before, signal });
    // Injected collectors follow the same enrollment authority as real collectors.
    s.enrollment = before;
    if (digest(before) !== digest(await readState(home, store))) {
      s.complete = false;
      s.blockers.push('Enrollment changed during collection');
    }
    return s;
  };
  const lastPath = join(home, storeKey(store), 'last-run.json');
  if (command === 'status') {
    const s = await snapshot();
    let lastRun = null;
    try {
      lastRun = await readJson(lastPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return { collection: s, plan: planImages(s), lastRun };
  }
  if (command === 'enroll') {
    if (!initial.complete) throw Error('Cannot enroll a partial store inventory');
    const state = await enrollStore(home, store, await readJson(options['--reviewed']), signal);
    return {
      enrolled: true,
      review: state.review,
      policyEnabled: false,
      blockers: planImages(await snapshot()).blockers,
    };
  }
  return withStoreLock(
    home,
    store,
    async () => {
      if (command === 'plan') {
        const plan = planImages(await snapshot());
        await writeJson(options['--output'], plan, true);
        return plan;
      }
      const plan = await readJson(options['--plan']);
      if (digest(plan.store) !== digest(store))
        throw Error('Selected store differs from planned store');
      const result = await applyImages(
        plan,
        {
          collect: snapshot,
          remove: (id, abort) => remove(selection, id, undefined, abort),
          audit: (event) => appendAudit(home, store, event),
        },
        { signal },
      );
      await writeJson(lastPath, result);
      return result;
    },
    signal,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new globalThis.AbortController();
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => controller.abort());
  try {
    const result = await runStorageCommand(process.argv.slice(2), { signal: controller.signal });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.status === 'blocked' || result.status === 'partial' || result.blockers?.length)
      process.exitCode = 2;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Storage operation failed'}\n`,
    );
    process.exitCode = 1;
  }
}
