import { z } from 'zod';
import {
  AgentContextRecipeSchema,
  AgentContextSnapshotSchema,
  type AgentContextRecipe,
  type AgentContextSnapshot,
  type AgentLibraryVersion,
} from '@mitzo/protocol';
import { contextDigest } from './agent-context-compiler.js';
import { reviewedHandlerSourceArtifacts } from './connections/reviewed-handler-artifacts.js';
import type { OpenShellRuntime, OpenShellRuntimeManager } from './openshell-runtime.js';

export const SANDBOX_AGENT_COMPILER_REVISION =
  'mitzo-sandbox-context-v1:contexgin-683f9007db686e710ed9a5410468fe33df1c5382';
export const SANDBOX_CONTEXT_CONTEXGIN_COMMIT = '683f9007db686e710ed9a5410468fe33df1c5382';
const admissionMessages = {
  runtime:
    'Agent Library sandbox context needs a compatible reviewed runtime. Check the sandbox runtime configuration before retrying.',
  recipe:
    'The agent context recipe could not be compiled in this sandbox. Check selected documents, required sections and configured sandbox presets.',
  scope:
    'The saved agent context no longer matches this sandbox or runtime. Start a new chat to select fresh context.',
  authorization:
    'Agent profile authorization expired or was revoked. Sign in again before retrying.',
  cancelled: 'Sandbox agent context preparation was cancelled. Retry when ready.',
} as const;
/** Only these fixed messages cross the operator boundary; upstream output stays in cause. */
export class SandboxAgentContextAdmissionError extends Error {
  constructor(
    readonly reason: keyof typeof admissionMessages,
    cause?: unknown,
  ) {
    super(admissionMessages[reason], { cause });
    this.name = 'SandboxAgentContextAdmissionError';
  }
}
export function sandboxAgentContextAdmissionFailure(error: unknown, aborted: boolean) {
  const message = error instanceof Error ? error.message : '';
  const reason =
    aborted || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
      ? 'cancelled'
      : /^(Agent profile authorization|Interactive operator authentication|Operator revoked)/.test(
            message,
          )
        ? 'authorization'
        : /^(Saved sandbox agent|Agent context sandbox|OpenShell sandbox (identity|is not owned)|Sandbox agent context (runtime changed|returned another))/.test(
              message,
            )
          ? 'scope'
          : /^(Runtime is incompatible|Agent Library sandbox recipes|Sandbox agent context requires|Agent context requires)/.test(
                message,
              )
            ? 'runtime'
            : 'recipe';
  return new SandboxAgentContextAdmissionError(reason, error);
}
export const sandboxAgentCompilerHash = () =>
  contextDigest({
    entrypoint:
      reviewedHandlerSourceArtifacts['../../docs/spikes/openshell-codex/compile-agent-context.mjs'],
    workspace: reviewedHandlerSourceArtifacts['../../scripts/agent-workspace-context.mjs'],
  });
export const SandboxAgentPresetsSchema = z
  .record(z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/), AgentContextRecipeSchema.options[0])
  .refine((value) => Object.keys(value).length <= 100, 'Too many sandbox context presets');
export type SandboxAgentPresets = z.infer<typeof SandboxAgentPresetsSchema>;

/** A preset name selects host configuration; it never fetches host-compiled text. */
export function sandboxWorkspaceRecipe(recipe: AgentContextRecipe, presets?: SandboxAgentPresets) {
  const parsed = AgentContextRecipeSchema.parse(recipe);
  if (parsed.source === 'workspace') return parsed;
  const preset = presets?.[parsed.agentName];
  if (!preset) throw Error('Sandbox context preset is not configured');
  return AgentContextRecipeSchema.options[0].parse(preset);
}
export async function resolveSandboxAgentContext(input: {
  profile?: AgentLibraryVersion;
  stored?: AgentContextSnapshot;
  conversationId: string;
  runtime: OpenShellRuntime;
  manager: OpenShellRuntimeManager;
  presets?: SandboxAgentPresets;
  signal: AbortSignal;
}): Promise<AgentContextSnapshot | undefined> {
  input.signal.throwIfAborted();
  const profile = input.profile;
  const recipe = profile?.definition.contextRecipe;
  if (!profile || !recipe) {
    if (input.stored) throw Error('Saved sandbox agent context has no matching profile recipe');
    return undefined;
  }
  const effective = sandboxWorkspaceRecipe(recipe, input.presets);
  const effectiveRecipeHash = contextDigest(effective);
  const stored = input.stored && AgentContextSnapshotSchema.parse(input.stored);
  if (stored) {
    if (
      stored.profileId !== profile.profileId ||
      stored.revision !== profile.revision ||
      stored.profileHash !== profile.contentHash
    )
      throw Error('Saved sandbox agent context belongs to another profile');
    if (!stored.sandbox || stored.compilerRevision !== SANDBOX_AGENT_COMPILER_REVISION)
      throw Error('Saved sandbox agent context compiler is incompatible');
    if (
      stored.recipeHash !== contextDigest(recipe) ||
      stored.source !== recipe.source ||
      stored.sandbox.effectiveRecipeHash !== effectiveRecipeHash
    )
      throw Error('Saved sandbox agent context recipe or configured preset changed');
    if (stored.payloadHash !== contextDigest(stored.context))
      throw Error('Saved sandbox agent context payload hash differs');
  }
  const scope = await input.manager.verifyAgentContextRuntime(
    input.conversationId,
    input.runtime,
    input.signal,
  );
  if (stored) {
    if (
      contextDigest(stored.sandbox) !== contextDigest({ ...scope, effectiveRecipeHash }) ||
      (recipe.source === 'workspace' &&
        stored.workspaceIdentity !== contextDigest(input.runtime.workdir))
    )
      throw Error(
        'Saved sandbox agent context workspace or runtime scope changed; start a new chat',
      );
    input.signal.throwIfAborted();
    return stored;
  }
  const compiled = await input.manager.compileAgentContext(input.runtime, effective, input.signal);
  if (
    compiled.compilerRevision !== SANDBOX_AGENT_COMPILER_REVISION ||
    compiled.workspaceIdentity !== contextDigest(input.runtime.workdir)
  )
    throw Error('Sandbox agent context returned another compiler or workspace');
  const after = await input.manager.verifyAgentContextRuntime(
    input.conversationId,
    input.runtime,
    input.signal,
  );
  if (contextDigest(after) !== contextDigest(scope))
    throw Error('Sandbox agent context runtime changed during compilation');
  input.signal.throwIfAborted();
  return AgentContextSnapshotSchema.parse({
    profileId: profile.profileId,
    revision: profile.revision,
    profileHash: profile.contentHash,
    source: recipe.source,
    compilerRevision: compiled.compilerRevision,
    recipeHash: contextDigest(recipe),
    payloadHash: contextDigest(compiled.context),
    ...(recipe.source === 'workspace' ? { workspaceIdentity: compiled.workspaceIdentity } : {}),
    sandbox: { ...scope, effectiveRecipeHash },
    context: compiled.context,
  });
}
