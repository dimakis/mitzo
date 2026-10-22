import { createHash, randomUUID } from 'node:crypto';
import {
  PROFILE_BUILDER_ID,
  profileBuilderDefinitionForRevision,
  DEFAULT_MITZO_PROFILE_ID,
  DEFAULT_MITZO_PROFILE_REVISION,
  defaultMitzoProfileDefinition,
  AgentLibraryVersionSchema,
  type AgentProfileSelection,
} from '@mitzo/protocol';
import { registerAuthSession, isAuthSessionCurrent, type AuthSession } from './auth.js';
import { custodianControllerClient } from './symposium-custodian-mode.js';
import { getAgentLibrary } from './agent-library-runtime.js';

const operators = new Map<string, AuthSession>();
export function captureAgentLibraryAuthorization(connectionId?: string) {
  const auth = connectionId ? operators.get(connectionId) : undefined;
  if (!auth || auth.expiresAt <= Date.now())
    throw Error('Interactive operator authentication is required to select an agent profile');
  return {
    auth,
    assertCurrent() {
      if (operators.get(connectionId!) !== auth || auth.expiresAt <= Date.now())
        throw Error('Agent profile authorization expired or revoked');
    },
  };
}
/** A single awaited operation keeps its exact operator, including across reconnect/logout. */
export function captureAgentLibraryOperation(connectionId: string) {
  const authorization = captureAgentLibraryAuthorization(connectionId);
  const controller = new AbortController();
  const dispose = registerAuthSession(authorization.auth, () => controller.abort());
  return {
    signal: controller.signal,
    dispose,
    assertCurrent() {
      controller.signal.throwIfAborted();
      authorization.assertCurrent();
      if (!isAuthSessionCurrent(authorization.auth)) throw Error('Operator authorization revoked');
    },
  };
}
/** Called only with middleware-verified transport authentication; never a request body. */
export function bindAgentLibraryTransport(connectionId: string, auth: AuthSession): () => void {
  operators.set(connectionId, auth);
  const unregister = registerAuthSession(auth, () => {
    operators.delete(connectionId);
    custodianControllerClient?.invalidate(auth.id);
  });
  return () => {
    operators.delete(connectionId);
    unregister();
  };
}
/** Scope retained-session recovery to middleware-verified authorization, never caller JSON. */
export async function withAgentLibraryRecoveryAuthorization<T>(
  auth: AuthSession | undefined,
  operation: (operatorConnectionId?: string) => Promise<T>,
): Promise<T> {
  if (!auth) return operation(undefined);
  const connectionId = `agent-recovery:${randomUUID()}`;
  const release = bindAgentLibraryTransport(connectionId, auth);
  try {
    captureAgentLibraryAuthorization(connectionId);
    return await operation(connectionId);
  } finally {
    release();
  }
}
/** Builtin identity is code-owned and never resolved through the user Library. */
export function readBuiltinAgentLibraryProfile(selection: AgentProfileSelection) {
  if (selection.kind === 'builtin') {
    const definition =
      selection.profileId === DEFAULT_MITZO_PROFILE_ID &&
      selection.revision === DEFAULT_MITZO_PROFILE_REVISION
        ? structuredClone(defaultMitzoProfileDefinition)
        : selection.profileId === PROFILE_BUILDER_ID
          ? profileBuilderDefinitionForRevision(selection.revision)
          : undefined;
    if (!definition) return null;
    return {
      kind: 'builtin' as const,
      profileId: selection.profileId,
      revision: selection.revision,
      definition,
      contentHash: createHash('sha256').update(JSON.stringify(definition)).digest('hex'),
    };
  }
  return null;
}
export async function readAgentLibraryProfile(
  selection: AgentProfileSelection,
  connectionId?: string,
) {
  const captured = captureAgentLibraryAuthorization(connectionId);
  const auth = captured.auth;
  if (selection.kind === 'builtin') return readBuiltinAgentLibraryProfile(selection);
  if (!custodianControllerClient)
    return getAgentLibrary().version('user', selection.profileId, selection.revision);
  const response = await custodianControllerClient.request(
    {
      requestId: randomUUID(),
      operation: 'library.read',
      resourceId: selection.profileId,
      revision: String(selection.revision),
      body: {},
      query: {},
      authorization: auth,
    },
    undefined,
    AbortSignal.timeout(5000),
  );
  captured.assertCurrent();
  if (response.status === 404) return null;
  if (response.status !== 200)
    throw Error('Agent Library owner could not resolve the selected revision');
  return AgentLibraryVersionSchema.parse(response.body);
}
