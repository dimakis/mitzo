import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AccountBinding } from '@mitzo/protocol';
import type { OpenShellRuntime, OpenShellAccountRoute } from './openshell-runtime.js';
import type { TerminalTarget } from './terminal-service.js';

type Runtime = OpenShellRuntime & { sandboxId: string };
interface Session {
  title?: string | null;
  cwd?: string | null;
  accountBinding?: AccountBinding | null;
}
export function createTerminalTargetResolver(deps: {
  hostCwd: string;
  session(id: string): Session | null | undefined;
  allowedHost(cwd: string): boolean;
  remote(id: string): boolean;
  runtime(
    id: string,
    binding: AccountBinding,
  ): { runtime: Runtime; route: OpenShellAccountRoute } | null;
  currentRoute(binding: AccountBinding, id: string): OpenShellAccountRoute;
  validateRuntime(runtime: Runtime): void;
  inspect(
    id: string,
    runtime: Runtime,
    route: OpenShellAccountRoute,
  ): Promise<{ id: string; phase: string } | undefined>;
}) {
  return async (request: { sessionId?: string }, _owner: string): Promise<TerminalTarget> => {
    if (!request.sessionId)
      return {
        kind: 'host',
        label: 'Your Mac',
        cwd: deps.hostCwd,
        identity: createHash('sha256').update(`host:${deps.hostCwd}`).digest('hex'),
      };
    const id = request.sessionId;
    const meta = deps.session(id);
    if (!meta?.cwd) throw new Error('Chat workspace unavailable');
    if (!deps.remote(id)) {
      if (!deps.allowedHost(meta.cwd)) throw new Error('Chat workspace unavailable');
      return {
        kind: 'host',
        label: meta.title || 'Chat workspace',
        cwd: meta.cwd,
        sessionId: id,
        identity: createHash('sha256')
          .update(JSON.stringify(['host', id, meta.cwd]))
          .digest('hex'),
      };
    }
    if (!meta.accountBinding) throw new Error('Sandbox terminal unavailable');
    const selected = deps.runtime(id, meta.accountBinding);
    if (!selected?.runtime.sandboxId) throw new Error('Sandbox terminal unavailable');
    const { runtime, route } = selected;
    if (
      runtime.workdir !== meta.cwd ||
      !isDeepStrictEqual(route, deps.currentRoute(meta.accountBinding, id))
    )
      throw new Error('Sandbox binding changed');
    deps.validateRuntime(runtime);
    const observation = await deps.inspect(id, runtime, route);
    if (observation?.id !== runtime.sandboxId || observation.phase !== 'Ready')
      throw new Error('Sandbox terminal unavailable');
    const identity = createHash('sha256')
      .update(
        JSON.stringify([
          id,
          meta.accountBinding.profileRevision,
          runtime.sandboxId,
          runtime.sandboxName,
          runtime.workdir,
          runtime.gateway,
          runtime.gatewayEndpoint,
          runtime.workspace,
        ]),
      )
      .digest('hex');
    return {
      kind: 'sandbox',
      label: meta.title || 'Chat sandbox',
      cwd: runtime.workdir,
      sessionId: id,
      identity,
      runtime,
    };
  };
}
