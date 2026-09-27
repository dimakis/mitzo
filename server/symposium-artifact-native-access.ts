import { execFile } from 'node:child_process';
import { openShellSshArgvProcessSpec } from './codex-app-server-client.js';
import type { OwnedSymposiumGateway } from './symposium-owned-gateway.js';
export type NativeArtifactAccessProbe = (
  name: string,
  id: string,
  script: string,
) => Promise<unknown>;
/** Probe through the same native SSH identity resolution as model execution,
 * never a Podman --user override. Guard the gateway's immutable ID on both sides. */
export async function probeOwnedArtifactAccess(
  gateway: OwnedSymposiumGateway,
  name: string,
  id: string,
  script: string,
): Promise<unknown> {
  const run = (command: string, args: readonly string[], env: NodeJS.ProcessEnv) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        command,
        [...args],
        { env, timeout: 15000, maxBuffer: 16384, encoding: 'utf8' },
        (error, stdout) => {
          if (error) reject(new Error('Native artifact access probe failed'));
          else resolve(stdout);
        },
      );
    });
  const identity = async () => {
    gateway.verifyCustody();
    const row = JSON.parse(
      await run(
        gateway.cli,
        [
          'sandbox',
          '--gateway',
          gateway.gateway,
          '--workspace',
          gateway.workspace,
          'get',
          name,
          '-o',
          'json',
        ],
        gateway.managementEnvironment,
      ),
    );
    gateway.verifyCustody();
    if (
      row.id !== id ||
      row.name !== name ||
      row.workspace !== gateway.workspace ||
      row.phase !== 'Ready'
    )
      throw new Error('Native artifact sandbox identity changed');
  };
  await identity();
  const spec = openShellSshArgvProcessSpec(
    {
      sandboxName: name,
      workdir: '/sandbox/workspaces/mgmt',
      cli: gateway.cli,
      gateway: gateway.gateway,
      workspace: gateway.workspace,
      cliEnvironment: { ...gateway.managementEnvironment },
    },
    ['/bin/bash', '-c', script],
    {},
  );
  const result = JSON.parse(await run(spec.command, spec.args, spec.env));
  await identity();
  return result;
}
