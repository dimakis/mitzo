import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { MaintenancePlan, MaintenanceRequirement } from './deployment-maintenance-format.js';
import { publishPrivateOperationFile, readPrivateOperationFile } from './private-operation-file.js';

const VolumeUuid = z.uuid();
const FileIdentity = z.strictObject({
  volumeUuid: VolumeUuid,
  inode: z.string().regex(/^[1-9][0-9]*$/),
  birthNs: z.string().regex(/^[1-9][0-9]*$/),
});
const StableIdentity = z.strictObject({
  version: z.literal(1),
  planSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sealSha256: z.string().regex(/^[a-f0-9]{64}$/),
  basis: z.enum(['original-device', 'completed-handoff']),
  events: FileIdentity,
  native: FileIdentity,
});
type Plan = z.infer<typeof MaintenancePlan>;
type Requirement = z.infer<typeof MaintenanceRequirement>;
type IdentityBinding = z.infer<typeof StableIdentity>;

// Resolve both UUIDs in a single macOS Foundation call. A volume with no
// persistent UUID cannot provide a stable identity.
const volumeScript = `
ObjC.import('Foundation');
function run(paths) {
  return JSON.stringify(paths.map(function (path) {
    var value = Ref();
    var url = $.NSURL.fileURLWithPath(path);
    if (!url.getResourceValueForKeyError(value, $.NSURLVolumeUUIDStringKey, null)) return null;
    return ObjC.unwrap(value[0]);
  }));
}
`;

export function readMaintenanceVolumeUuids(paths: [string, string]): [string, string] {
  if (process.platform !== 'darwin') throw Error('Persistent macOS database volume required');
  const output = execFileSync(
    '/usr/bin/osascript',
    ['-l', 'JavaScript', '-e', volumeScript, ...paths],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
      maxBuffer: 4096,
    },
  );
  const uuids = z.tuple([VolumeUuid, VolumeUuid]).parse(JSON.parse(output));
  return [uuids[0].toLowerCase(), uuids[1].toLowerCase()];
}

function inspectDatabase(
  configured: string,
  original: Plan['events'],
  requireOriginalDevice: boolean,
) {
  const selected = lstatSync(configured, { bigint: true });
  const retained = lstatSync(original.path, { bigint: true });
  const path = realpathSync(original.path);
  if (
    !selected.isFile() ||
    !retained.isFile() ||
    Number(selected.uid) !== process.getuid?.() ||
    selected.uid !== retained.uid ||
    selected.nlink !== 1n ||
    retained.nlink !== 1n ||
    realpathSync(configured) !== path ||
    selected.dev !== retained.dev ||
    selected.ino !== retained.ino ||
    selected.birthtimeNs !== retained.birthtimeNs ||
    retained.ino !== BigInt(original.identity.ino) ||
    (requireOriginalDevice && retained.dev !== BigInt(original.identity.dev))
  )
    throw Error('Configured runtime database must retain original maintenance identity');
  return {
    path,
    dev: retained.dev,
    inode: retained.ino.toString(),
    birthNs: retained.birthtimeNs.toString(),
  };
}

export function inspectMaintenanceDatabases(
  plan: Plan,
  configured: [string, string],
  requireOriginalDevice: boolean,
  volumeProbe?: typeof readMaintenanceVolumeUuids,
) {
  const inspect = () =>
    [
      inspectDatabase(configured[0], plan.events, requireOriginalDevice),
      inspectDatabase(configured[1], plan.native, requireOriginalDevice),
    ] as const;
  const before = inspect();
  if (!volumeProbe) return;
  const uuids = volumeProbe([before[0].path, before[1].path]);
  if (!isDeepStrictEqual(before, inspect()))
    throw Error('Maintenance databases changed during persistent volume lookup');
  return {
    events: FileIdentity.parse({
      volumeUuid: uuids[0],
      inode: before[0].inode,
      birthNs: before[0].birthNs,
    }),
    native: FileIdentity.parse({
      volumeUuid: uuids[1],
      inode: before[1].inode,
      birthNs: before[1].birthNs,
    }),
  };
}

export function readMaintenanceIdentity(required: Requirement): IdentityBinding | undefined {
  let bytes: Buffer;
  try {
    bytes = readPrivateOperationFile(required.planFile + '.database-identity.json', 16 * 1024);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const record = StableIdentity.parse(JSON.parse(bytes.toString('utf8')));
  if (record.planSha256 !== required.planSha256 || record.sealSha256 !== required.sealSha256)
    throw Error('Database identity record does not bind the original handoff');
  return record;
}

export function publishMaintenanceIdentity(
  required: Requirement,
  basis: IdentityBinding['basis'],
  identities: Pick<IdentityBinding, 'events' | 'native'>,
): void {
  const existing = readMaintenanceIdentity(required);
  if (existing) {
    if (!isDeepStrictEqual(identities, { events: existing.events, native: existing.native }))
      throw Error('Retained database identity changed');
    return;
  }
  publishPrivateOperationFile(
    required.planFile + '.database-identity.json',
    JSON.stringify({
      version: 1,
      planSha256: required.planSha256,
      sealSha256: required.sealSha256,
      basis,
      ...identities,
    }) + '\n',
  );
}
