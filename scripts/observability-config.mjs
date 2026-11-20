import process from 'node:process';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const INPUTS = [
  'docker-compose.yml',
  'infra/loki-config.yaml',
  'infra/jaeger-v2-config.yaml',
  'infra/grafana/provisioning',
];
const DASHBOARD = 'infra/grafana/provisioning/dashboards/json/mitzo-observability.json';
function entries(root, paths = INPUTS) {
  return paths.flatMap((path) => {
    const full = join(root, path);
    if (lstatSync(full).isSymbolicLink()) throw new Error('UNSAFE_OBSERVABILITY_CONFIG');
    let names;
    try {
      names = readdirSync(full);
    } catch (error) {
      if (error.code !== 'ENOTDIR') throw error;
      return [[path, readFileSync(full)]];
    }
    return names.sort().flatMap((name) => entries(root, [join(path, name)]));
  });
}
function digest(contents) {
  const hash = createHash('sha256');
  for (const [path, bytes] of contents) hash.update(path).update('\0').update(bytes).update('\0');
  return hash.digest('hex');
}
function publicUrl(value) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('INVALID_OBSERVABILITY_PUBLIC_URL');
  return url.href.replace(/\/$/, '');
}
/** Freeze the exact input bytes before hashing/copying. No release paths survive in mounts. */
export function stageObservabilityConfig(sourceRoot, stateRoot, { jaegerUiUrl, mlflowUiUrl } = {}) {
  const contents = entries(sourceRoot).map(([path, bytes]) => {
    if (path !== DASHBOARD || (!jaegerUiUrl && !mlflowUiUrl)) return [path, bytes];
    const dashboard = JSON.parse(bytes.toString());
    for (const link of dashboard.links) {
      if (link.title === 'Search traces' && jaegerUiUrl)
        link.url = `${publicUrl(jaegerUiUrl)}/search?service=mitzo`;
      if (link.title === 'Learning experiments' && mlflowUiUrl) link.url = publicUrl(mlflowUiUrl);
    }
    return [path, Buffer.from(JSON.stringify(dashboard, null, 2) + '\n')];
  });
  const hash = digest(contents);
  const target = resolve(stateRoot, 'configs', hash);
  if (existsSync(target)) {
    // Enumerate the target too: an extra provisioned dashboard is meaningful configuration.
    if (digest(entries(target)) !== hash) throw new Error('OBSERVABILITY_CONFIG_INTEGRITY');
    return target;
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    mkdirSync(temporary, { mode: 0o700 });
    for (const [path, bytes] of contents) {
      mkdirSync(dirname(join(temporary, path)), { recursive: true });
      writeFileSync(join(temporary, path), bytes);
    }
    if (digest(entries(temporary)) !== hash) throw new Error('OBSERVABILITY_CONFIG_INTEGRITY');
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return target;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const savedPath = join(resolve(process.argv[2]), 'public-urls.json');
  const saved = existsSync(savedPath) ? JSON.parse(readFileSync(savedPath, 'utf8')) : {};
  console.log(
    stageObservabilityConfig(
      resolve(dirname(fileURLToPath(import.meta.url)), '..'),
      process.argv[2],
      {
        jaegerUiUrl: process.env.MITZO_JAEGER_UI_URL ?? saved.jaegerUiUrl,
        mlflowUiUrl: process.env.MITZO_MLFLOW_UI_URL ?? saved.mlflowUiUrl,
      },
    ),
  );
}
