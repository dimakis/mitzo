import { isDeepStrictEqual } from 'node:util';
import type { AccountBinding } from '@mitzo/protocol';
import type {
  OpenShellRuntime,
  OpenShellAccountRoute,
  OpenShellRuntimeConfig,
} from './openshell-runtime.js';

type Runtime = OpenShellRuntime & { sandboxId: string };
export class SessionArtifactUnavailableError extends Error {
  readonly status = 409;
}
export interface SessionArtifactReaderDependencies {
  readRuntime(
    id: string,
    binding: AccountBinding,
  ): { runtime: Runtime; route: OpenShellAccountRoute } | null;
  currentRoute(binding: AccountBinding): OpenShellAccountRoute;
  validateRuntime(runtime: Runtime): void;
  inspect(
    id: string,
    runtime: Runtime,
    route: OpenShellAccountRoute,
    signal: AbortSignal,
  ): Promise<{ id: string; phase: string } | undefined>;
  read(
    runtime: Runtime,
    path: string,
    signal: AbortSignal,
    verify: () => Promise<void>,
  ): Promise<{ path: string; bytes: Buffer }>;
}
export function isOpenShellArtifactSession(
  meta: { cwd?: string | null; accountBinding?: { provider: string } | null } | null | undefined,
  configuredWorkdir?: string,
) {
  return Boolean(
    meta?.cwd &&
    ['openai', 'openai-codex'].includes(meta.accountBinding?.provider ?? '') &&
    (meta.cwd.startsWith('/sandbox/') || (configuredWorkdir && meta.cwd === configuredWorkdir)),
  );
}
export function validateSessionArtifactRuntime(
  runtime: Runtime,
  config:
    | Pick<
        OpenShellRuntimeConfig,
        | 'cli'
        | 'gateway'
        | 'workspace'
        | 'workdir'
        | 'gatewayEndpoint'
        | 'gatewayInsecure'
        | 'cliEnvironment'
      >
    | undefined,
) {
  if (
    !config ||
    [
      'cli',
      'gateway',
      'workspace',
      'workdir',
      'gatewayEndpoint',
      'gatewayInsecure',
      'cliEnvironment',
    ].some(
      (key) =>
        !isDeepStrictEqual(runtime[key as keyof Runtime], config[key as keyof typeof config]),
    )
  )
    throw Error('Sandbox runtime configuration changed');
}

export function createSessionArtifactReader(deps: SessionArtifactReaderDependencies) {
  return async (id: string, binding: AccountBinding, cwd: string, path: string) => {
    let stored: ReturnType<typeof deps.readRuntime>;
    try {
      stored = deps.readRuntime(id, binding);
    } catch {
      stored = null;
    }
    if (!stored)
      throw new SessionArtifactUnavailableError(
        'This conversation has no verified workspace receipt. Resume this conversation once, then try opening the file again.',
      );
    const { runtime, route } = stored;
    try {
      if (
        !runtime.sandboxId ||
        runtime.workdir !== cwd ||
        !isDeepStrictEqual(route, deps.currentRoute(binding))
      )
        throw Error('Workspace binding changed');
      deps.validateRuntime(runtime);
    } catch {
      throw new SessionArtifactUnavailableError(
        'This conversation’s workspace binding changed. Resume this conversation, then try opening the file again.',
      );
    }
    const signal = AbortSignal.timeout(30_000);
    const verify = async () => {
      let physical: Awaited<ReturnType<typeof deps.inspect>>;
      try {
        physical = await deps.inspect(id, runtime, route, signal);
      } catch {
        physical = undefined;
      }
      if (!physical || physical.id !== runtime.sandboxId || physical.phase !== 'Ready')
        throw new SessionArtifactUnavailableError(
          'This conversation’s workspace is unavailable or stopped. Resume this conversation to check access; deleted files cannot be recovered by the viewer.',
        );
    };
    return deps.read(runtime, path, signal, verify);
  };
}
