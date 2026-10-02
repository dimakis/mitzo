import { volumeEvidence } from './symposium-artifact-host.js';
import {
  assertSessionArtifactVolume,
  type SessionArtifactMapping,
} from './symposium-session-artifacts.js';
import type { SymposiumArtifactOwner } from './symposium-artifact-owner.js';
import { SYMPOSIUM_ARTIFACT_TARGET } from './symposium-artifact-lease.js';
type Command = (args: readonly string[]) => Promise<string>;
const helperIdPattern = /^[a-f0-9]{64}$/;
/** Fresh physical census, using the same volume/label parser as admission. */
export async function assertSourceVolume(input: {
  mapping: SessionArtifactMapping;
  workspace: string;
  owner: SymposiumArtifactOwner;
  command: Command;
  helperId?: string;
}): Promise<void> {
  const { mapping, workspace, owner, command, helperId } = input;
  const raw: unknown = JSON.parse(await command(['volume', 'inspect', mapping.volumeName]));
  assertSessionArtifactVolume(workspace, mapping, volumeEvidence(raw, mapping.volumeName));
  if (
    !Array.isArray(raw) ||
    raw.length !== 1 ||
    raw[0].UID !== owner.uid ||
    raw[0].GID !== owner.gid
  )
    throw Error('Source volume ownership changed');
  const rows: unknown = JSON.parse(
    await command([
      'ps',
      '--all',
      '--no-trunc',
      '--filter',
      `volume=${mapping.volumeName}`,
      '--format',
      'json',
    ]),
  );
  if (
    !Array.isArray(rows) ||
    rows.length > 128 ||
    rows.some((row) => !helperIdPattern.test(String(row.Id ?? row.ID ?? '')))
  )
    throw Error('Source volume census unavailable');
  for (const row of rows) {
    const id = String(row.Id ?? row.ID);
    if (id === helperId) continue;
    const detail: unknown = JSON.parse(await command(['inspect', id]));
    if (
      !Array.isArray(detail) ||
      detail.length !== 1 ||
      detail[0].Id !== id ||
      !Array.isArray(detail[0].Mounts) ||
      !detail[0].Mounts.some(
        (mount: { Type?: string; Name?: string }) =>
          mount.Type === 'volume' && mount.Name === mapping.volumeName,
      ) ||
      detail[0].Mounts.some(
        (mount: { Type?: string; Name?: string }) =>
          !mount.Type ||
          (mount.Type === 'volume' && (!mount.Name || mount.Name === mapping.volumeName)),
      )
    )
      throw Error('Source volume has an unaccounted mount');
  }
}
/** Exact helper isolation matches the bounded owned successor helper contract. */
export async function inspectSourceHelper(input: {
  command: Command;
  helperId: string;
  name: string;
  owner: SymposiumArtifactOwner;
}) {
  const { command, helperId, name, owner } = input;
  const rows: unknown = JSON.parse(await command(['inspect', helperId]));
  if (!Array.isArray(rows) || rows.length !== 1) throw Error('Source helper unavailable');
  const row = rows[0],
    mounts = row.Mounts;
  if (
    row.Id !== helperId ||
    row.Name?.replace(/^\//, '') !== `${name}-import` ||
    row.ImageName !== owner.image ||
    row.Config?.User !== `${owner.uid}:${owner.gid}` ||
    row.HostConfig?.NetworkMode !== 'none' ||
    row.HostConfig?.ReadonlyRootfs !== true ||
    row.HostConfig?.Privileged !== false ||
    !Array.isArray(mounts) ||
    mounts.filter((m) => m.Type === 'volume').length !== 1 ||
    !mounts.some(
      (m) =>
        m.Type === 'volume' &&
        m.Name === name &&
        m.Destination === SYMPOSIUM_ARTIFACT_TARGET &&
        m.RW === true,
    ) ||
    mounts.some((m) => m.Type !== 'volume' && !(m.Type === 'tmpfs' && m.Destination === '/tmp'))
  )
    throw Error('Source helper isolation changed');
  return row as { State?: { Running?: boolean; Status?: string; ExitCode?: number } };
}
