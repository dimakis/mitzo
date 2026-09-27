import { createHash } from 'node:crypto';
import { SYMPOSIUM_ARTIFACT_TARGET } from './symposium-artifact-lease.js';
import type { SymposiumArtifactOwner } from './symposium-artifact-owner.js';
export type ArtifactInitializerReceipt = {
  intent(name: string): void;
  created(id: string): void;
  removed(): void;
};
// An initializer sees only a fresh owned volume. No template, ambient config,
// author, commit, remote, credentials, seed upload, or external filesystem input.
export const ARTIFACT_GIT_INITIALIZER = String.raw`
import os, subprocess, sys
root=sys.argv[1]
if os.listdir(root):
    raise RuntimeError('artifact initialization requires empty directory')
env={'PATH':'/usr/bin:/bin','HOME':'/nonexistent','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0'}
subprocess.run(['/usr/bin/git','init','--quiet','--template=','--initial-branch=main',root],env=env,check=True,timeout=10)
if subprocess.check_output(['/usr/bin/git','-C',root,'symbolic-ref','HEAD'],env=env,text=True).strip()!='refs/heads/main':
    raise RuntimeError('unexpected artifact branch')
print('MITZO_GIT_INITIALIZED_V1')
`;
export function artifactGitContract(owner: SymposiumArtifactOwner): string {
  return JSON.stringify({
    ...owner,
    git: 1,
    initializerSha256: createHash('sha256').update(ARTIFACT_GIT_INITIALIZER).digest('hex'),
  });
}
export async function initializeArtifactGit(
  name: string,
  owner: SymposiumArtifactOwner,
  command: (args: readonly string[]) => Promise<string>,
  custody: () => void,
  receipt: ArtifactInitializerReceipt,
): Promise<void> {
  if (!/^mitzo-artifacts-[A-Za-z0-9-]+$/.test(name)) throw new Error('Invalid artifact name');
  custody();
  const helperName = `${name}-init`;
  receipt.intent(helperName);
  const helperId = (
    await command([
      'create',
      '--pull=never',
      '--name',
      helperName,
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit=32',
      '--memory=128m',
      '--cpus=1',
      '--timeout=20',
      '--user',
      `${owner.uid}:${owner.gid}`,
      '--mount',
      `type=volume,src=${name},dst=${SYMPOSIUM_ARTIFACT_TARGET}`,
      '--entrypoint=/usr/bin/python3',
      owner.image,
      '-I',
      '-B',
      '-c',
      ARTIFACT_GIT_INITIALIZER,
      SYMPOSIUM_ARTIFACT_TARGET,
    ])
  ).trim();
  if (!/^[a-f0-9]{64}$/.test(helperId))
    throw new Error('Artifact initializer identity unavailable');
  // Persist terminal create before a subsequent custody check/start can fail.
  receipt.created(helperId);
  custody();
  const output = await command(['start', '--attach', helperId]);
  if (output.trim() !== 'MITZO_GIT_INITIALIZED_V1')
    throw new Error('Artifact Git initialization failed');
  custody();
  // A failed or ambiguous start leaves the exact bounded helper for reconciliation.
  // Never delete by name or force-remove a potentially running initializer.
  await command(['rm', helperId]);
  receipt.removed();
  custody();
}
export async function createArtifactGitVolume(
  name: string,
  labels: Record<string, string>,
  owner: SymposiumArtifactOwner,
  command: (args: readonly string[]) => Promise<string>,
  custody: () => void,
  receipt: ArtifactInitializerReceipt,
): Promise<void> {
  custody();
  const result = await command([
    'volume',
    'create',
    '--driver',
    'local',
    '--uid',
    String(owner.uid),
    '--gid',
    String(owner.gid),
    ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
    name,
  ]);
  if (result.trim() !== name) throw new Error('Artifact volume creation identity changed');
  await initializeArtifactGit(name, owner, command, custody, receipt);
}
