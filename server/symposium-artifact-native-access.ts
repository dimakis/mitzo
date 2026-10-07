import {
  observeMountJson,
  observeNativeMountCommand,
  type OpenShellRuntimeConfig,
} from './openshell-runtime.js';
import { REVIEWED_SYMPOSIUM_OWNED_RUNTIME } from './symposium-owned-runtime-contract.js';
import { execFile } from 'node:child_process';
import { openShellSshArgvProcessSpec } from './codex-app-server-client.js';
import type { OwnedSymposiumGateway } from './symposium-owned-gateway.js';
import {
  atSymposiumReconciliationStage,
  atSymposiumReconciliationStageAsync,
} from './symposium-reconciliation-error.js';
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
  observer?: OpenShellRuntimeConfig['observeRuntime'],
): Promise<unknown> {
  const run = (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    operation: 'native-identity' | 'native-ssh-probe',
  ) =>
    new Promise<string>((resolve, reject) => {
      const started = observer ? performance.now() : 0;
      execFile(
        command,
        [...args],
        { env, timeout: 15000, maxBuffer: 16384, encoding: 'utf8' },
        (error, stdout, stderr) => {
          observeNativeMountCommand(observer, operation, started, error, stdout, stderr);
          if (error) {
            try {
              atSymposiumReconciliationStage(
                error.killed &&
                  error.signal === 'SIGTERM' &&
                  error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
                  ? 'SEAT_MOUNT_NATIVE_TIMEOUT'
                  : operation === 'native-identity'
                    ? 'SEAT_MOUNT_NATIVE_IDENTITY_FAILED'
                    : 'SEAT_MOUNT_NATIVE_ACCESS_FAILED',
                () => {
                  throw error;
                },
              );
            } catch (failure) {
              reject(failure);
            }
          } else resolve(stdout);
        },
      );
    });
  const identity = () =>
    atSymposiumReconciliationStageAsync('SEAT_MOUNT_NATIVE_IDENTITY_FAILED', async () => {
      atSymposiumReconciliationStage('SEAT_MOUNT_CUSTODY_FAILED', () => gateway.verifyCustody());
      const row = (await observeMountJson(observer, 'native-identity', () =>
        run(
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
          'native-identity',
        ),
      )) as Record<string, unknown>;
      atSymposiumReconciliationStage('SEAT_MOUNT_CUSTODY_FAILED', () => gateway.verifyCustody());
      if (
        row.id !== id ||
        row.name !== name ||
        row.workspace !== gateway.workspace ||
        row.phase !== 'Ready'
      )
        throw new Error('Native artifact sandbox identity changed');
    });
  await identity();
  const spec = atSymposiumReconciliationStage('SEAT_MOUNT_NATIVE_ACCESS_FAILED', () =>
    openShellSshArgvProcessSpec(
      {
        sandboxName: name,
        workdir: REVIEWED_SYMPOSIUM_OWNED_RUNTIME.workload.workdir,
        cli: gateway.cli,
        gateway: gateway.gateway,
        workspace: gateway.workspace,
        cliEnvironment: { ...gateway.managementEnvironment },
      },
      ['/bin/bash', '-c', script],
      {},
    ),
  );
  const result = await atSymposiumReconciliationStageAsync('SEAT_MOUNT_NATIVE_ACCESS_FAILED', () =>
    observeMountJson(observer, 'native-ssh-probe', () =>
      run(spec.command, spec.args, spec.env, 'native-ssh-probe'),
    ),
  );
  await identity();
  return result;
}
