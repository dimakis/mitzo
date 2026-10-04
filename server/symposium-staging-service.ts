import { randomBytes, createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { ownedCustodianEnvironment } from './symposium-custodian-launch.js';
import type { OwnedReleasePlan } from './symposium-owned-release.js';

const operatorName = 'staging-operator.json';
const Settings = z
  .object({
    AUTH_PASSPHRASE: z.string().min(32).max(256),
    AUTH_SECRET: z.string().min(64).max(256),
    PORT: z.string().regex(/^[0-9]{4,5}$/),
    MITZO_BIND_HOST: z.literal('127.0.0.1'),
  })
  .strict();
function privatePlan(plan: OwnedReleasePlan) {
  const s = lstatSync(plan.planDirectory);
  if (
    !isAbsolute(plan.planDirectory) ||
    realpathSync(plan.planDirectory) !== plan.planDirectory ||
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.uid !== process.getuid?.() ||
    (s.mode & 0o777) !== 0o700
  )
    throw Error('Private staging service plan required');
}
function absent(path: string) {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw Error('Staging service preparation already exists');
}
function privateBytes(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (
      !s.isFile() ||
      s.uid !== process.getuid?.() ||
      (s.mode & 0o777) !== 0o600 ||
      s.nlink !== 1 ||
      s.size > 8192
    )
      throw Error('Private staging operator file required');
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}
/** File-backed app authentication only. No provider values or ambient loaders. */
export function readStagingOperatorEnvironment(
  plan: OwnedReleasePlan,
  path: string,
  ambient: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  privatePlan(plan);
  if (path !== join(plan.planDirectory, operatorName)) throw Error('Staging operator path refused');
  const settings = Settings.parse(JSON.parse(privateBytes(path)));
  if (['3100', '3101'].includes(settings.PORT)) throw Error('Production staging port refused');
  return ownedCustodianEnvironment(plan, {
    NODE_OPTIONS: ambient.NODE_OPTIONS,
    NODE_PATH: ambient.NODE_PATH,
    DOTENV_CONFIG_PATH: ambient.DOTENV_CONFIG_PATH,
    ...settings,
  });
}
export function stagingServiceLabel(plan: OwnedReleasePlan): string {
  return (
    'com.mitzo.staging.' +
    createHash('sha256').update(plan.planDirectory).digest('hex').slice(0, 24)
  );
}
function xml(s: string) {
  if ([...s].some((character) => character.charCodeAt(0) < 32)) throw Error('Invalid service path');
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
function writeExclusive(path: string, value: string) {
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, value);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** Prepare the existing staging launcher for OS supervision. Never install/start,
 * restart an owner, or transfer custody from a receipt. Partial writes stay fenced. */
export function prepareStagingService(
  plan: OwnedReleasePlan,
  registrationPath: string,
  node: string,
  port: number,
) {
  privatePlan(plan);
  if (
    !isAbsolute(node) ||
    !isAbsolute(registrationPath) ||
    resolve(registrationPath) !== registrationPath ||
    realpathSync(registrationPath) !== registrationPath ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    [3100, 3101].includes(port)
  )
    throw Error('Staging service inputs refused');
  const operatorPath = join(plan.planDirectory, operatorName);
  const plistPath = join(plan.planDirectory, 'staging-custodian.plist');
  if (
    [operatorPath, plistPath, join(plan.planDirectory, 'owned-release.json')].includes(
      registrationPath,
    )
  )
    throw Error('Staging service inputs overlap');
  privateBytes(registrationPath);
  for (const path of [operatorPath, plistPath, join(plan.planDirectory, 'launch.intent')])
    absent(path);
  const settings = {
    AUTH_PASSPHRASE: randomBytes(32).toString('hex'),
    AUTH_SECRET: randomBytes(32).toString('hex'),
    PORT: String(port),
    MITZO_BIND_HOST: '127.0.0.1',
  };
  ownedCustodianEnvironment(plan, settings);
  const label = stagingServiceLabel(plan);
  const args = [
    node,
    join(plan.releaseRoot, 'scripts/start-staging-custodian.mjs'),
    join(plan.planDirectory, 'owned-release.json'),
    registrationPath,
    operatorPath,
  ];
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map((x) => `<string>${xml(x)}</string>`).join('')}</array><key>EnvironmentVariables</key><dict><key>NODE_OPTIONS</key><string></string><key>NODE_PATH</key><string></string><key>DOTENV_CONFIG_PATH</key><string>/dev/null</string></dict><key>WorkingDirectory</key><string>${xml(plan.releaseRoot)}</string><key>StandardOutPath</key><string>${xml(join(plan.planDirectory, 'owner.stdout.log'))}</string><key>StandardErrorPath</key><string>${xml(join(plan.planDirectory, 'owner.stderr.log'))}</string><key>KeepAlive</key><false/><key>RunAtLoad</key><false/><key>ExitTimeOut</key><integer>180</integer></dict></plist>\n`;
  writeExclusive(operatorPath, JSON.stringify(settings) + '\n');
  writeExclusive(plistPath, plist);
  const parent = openSync(plan.planDirectory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
  return { label, operatorPath, plistPath };
}
