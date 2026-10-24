import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  MODEL_COSTS,
  type ModelProvider,
  type ModelSession,
  type ModelSessionConfig,
  type CostRate,
} from '@mitzo/harness';
import {
  PaidReasoningPhaseSelectionsSchema,
  type PaidReasoningPhaseSelection,
} from '@mitzo/protocol';
import type { AdviserRequest } from './terminal-adviser.js';
import type { AdviserFeatureOwner } from './adviser-harness-runtime.js';

export class PaidReasoningSelectionError extends Error {}
/** Safe persisted classification; arbitrary provider error messages never enter history. */
export class PaidReasoningUsageCostUnknownError extends PaidReasoningSelectionError {
  readonly code = 'paid_reasoning_cost_unknown';
  constructor() {
    super(
      'Actual cached-token usage requires operator-qualified cache rates. Inspect this phase outcome before retrying; its cost is unknown, not zero.',
    );
  }
}
interface PhaseQualification {
  assertCurrent(): void;
  rate?: CostRate;
}
export interface PaidReasoningHarnessDependencies {
  /** Pure account/target/capability qualification. No model invocation. */
  qualify(
    selection: PaidReasoningPhaseSelection,
    owner: Omit<AdviserFeatureOwner, 'feature'>,
  ): Promise<PhaseQualification>;
  createSession(
    config: ModelSessionConfig,
    request: AdviserRequest,
    owner: AdviserFeatureOwner,
  ): Promise<ModelSession>;
}
function fail(message: string): never {
  throw new PaidReasoningSelectionError(message);
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const production: PaidReasoningHarnessDependencies = {
  async qualify(selection, owner) {
    const { loadAccountProfiles } = await import('./account-profiles.js');
    const { sessionHarnessForProvider } = await import('./session-harness-routing.js');
    const { ordinaryRepositoryRuntimeInventory } = await import('./ordinary-local-codex-entry.js');
    const { captureAgentLibraryAuthorization } = await import('./agent-library-transport.js');
    const authorization = captureAgentLibraryAuthorization(owner.operatorConnectionId);
    if (authorization.auth.id !== owner.authSessionId)
      fail(
        'The original reasoning operator is required. Review this phase with the current login.',
      );
    const current = () => {
      authorization.assertCurrent();
      const profiles = loadAccountProfiles();
      const account = profiles.resolve(selection.binding.account.accountId, selection.model);
      if (
        !isDeepStrictEqual(selection.binding.account, {
          accountId: account.accountId,
          provider: account.provider,
          profileRevision: account.profileRevision,
        }) ||
        sessionHarnessForProvider(account.provider) !== selection.binding.harness.implementation
      )
        fail(`The selected ${selection.role} account changed; review its phase selection again.`);
      profiles.validateModelSelection(account, selection.model, selection.thinking);
      const inventory = ordinaryRepositoryRuntimeInventory(
        'local',
        selection.binding.harness.implementation,
      );
      const resolved = inventory.catalog.resolve({
        account: selection.binding.account,
        harness: selection.binding.harness.implementation,
        targetId: selection.binding.execution.targetId,
        mode: 'ask',
      });
      if (
        resolved.status !== 'compatible' ||
        !isDeepStrictEqual(resolved.binding, selection.binding)
      )
        fail(`The selected ${selection.role} target changed or is unavailable.`);
    };
    current();
    const profiles = loadAccountProfiles();
    const rate = profiles.paidReasoningRate(
      profiles.resolve(selection.binding.account.accountId, selection.model),
    );
    return { assertCurrent: current, ...(rate ? { rate } : {}) };
  },
  async createSession(config, request, owner) {
    const { createTerminalAdviserSession } = await import('./terminal-adviser-model.js');
    return createTerminalAdviserSession(config, request, owner);
  },
};

/** Adapts one scoped native turn per existing reasoning role. The existing
 * orchestrators retain phase order, budgets, durable attempts and cancellation.
 * No account/model is inferred from a model prefix or another participant. */
export async function preparePaidReasoningHarness(
  input: {
    roles: readonly string[];
    selections: unknown;
    owner: Omit<AdviserFeatureOwner, 'feature'>;
    phasePrefix?: string;
    signal?: AbortSignal;
  },
  deps: PaidReasoningHarnessDependencies = production,
) {
  const parsed = PaidReasoningPhaseSelectionsSchema.safeParse(input.selections);
  if (!parsed.success)
    fail(
      'Choose an account, model, target and output policy for every reasoning role using phaseSelections.',
    );
  const selections = structuredClone(parsed.data);
  if (
    selections.length !== input.roles.length ||
    input.roles.some((role) => !selections.some((phase) => phase.role === role))
  )
    fail(`Select exactly these reasoning roles: ${input.roles.join(', ')}.`);
  const phases = new Map<
    string,
    { selection: PaidReasoningPhaseSelection; qualification: PhaseQualification; rate: CostRate }
  >();
  // Qualify every role before the outer owner allocates any provider attempt.
  for (const selection of selections) {
    if (selection.binding.execution.location !== 'local')
      fail(
        `The selected ${selection.role} reasoning target is unavailable; select a qualified Local Mac target.`,
      );
    const provider = selection.binding.account.provider;
    if (selection.outputPolicy.kind === 'exact-token-ceiling' && provider !== 'google-vertex')
      fail(
        `The ${selection.role} native harness cannot enforce an exact output-token ceiling. Review native-default output policy or choose a qualified capability.`,
      );
    let qualification: PhaseQualification;
    try {
      qualification = await deps.qualify(selection, input.owner);
    } catch (error) {
      if (error instanceof PaidReasoningSelectionError) throw error;
      fail(
        `The selected ${selection.role} account or target is unavailable. Review its phase selection.`,
      );
    }
    const staticRate =
      (provider === 'anthropic-vertex' && selection.model.startsWith('claude-')) ||
      (provider === 'google-vertex' && selection.model.startsWith('gemini-'))
        ? MODEL_COSTS[selection.model]
        : undefined;
    const rate = qualification.rate ?? staticRate;
    if (
      !rate ||
      !Number.isFinite(rate.inputPerMillion) ||
      rate.inputPerMillion < 0 ||
      !Number.isFinite(rate.outputPerMillion) ||
      rate.outputPerMillion < 0 ||
      rate.inputPerMillion + rate.outputPerMillion <= 0 ||
      [rate.cacheReadPerMillion, rate.cacheCreationPerMillion].some(
        (value) => value !== undefined && (!Number.isFinite(value) || value < 0),
      )
    )
      fail(
        `Pricing is not qualified for ${selection.role}. Choose a model with configured rates on its selected provider; unknown pricing never means free work.`,
      );
    phases.set(selection.role, { selection, qualification, rate: { ...rate } });
  }
  const routeRevision = () => {
    for (const phase of phases.values()) phase.qualification.assertCurrent();
    return digest({
      version: 1,
      selections,
      pricing: [...phases].map(([role, phase]) => [role, phase.rate]),
    });
  };
  routeRevision();
  const createProvider = (model: string, role?: string): ModelProvider => {
    const phase = role ? phases.get(role) : undefined;
    if (!phase || phase.selection.model !== model)
      return fail('The reasoning role/model does not match its reviewed selection.');
    const { selection, qualification, rate } = phase;
    return {
      name: selection.binding.account.provider,
      async call(messages, options = {}) {
        const signal =
          input.signal && options.signal
            ? AbortSignal.any([input.signal, options.signal])
            : (input.signal ?? options.signal);
        signal?.throwIfAborted();
        qualification.assertCurrent();
        const native = selection.binding.account.provider !== 'google-vertex';
        if (native && options.maxTokens !== undefined)
          fail(
            `The ${selection.role} native harness cannot enforce the requested output-token ceiling.`,
          );
        const system = messages
          .filter((message) => message.role === 'system')
          .map((message) => message.content)
          .join('\n\n');
        const conversation = messages
          .filter((message) => message.role !== 'system')
          .map((message) => ({
            role: message.role as 'user' | 'assistant',
            content: message.content,
          }));
        if (!conversation.length || conversation.at(-1)?.role !== 'user')
          fail('The reasoning phase requires an explicit final user request.');
        const request: AdviserRequest = {
          accountId: selection.binding.account.accountId,
          model,
          reasoningEffort: selection.thinking,
          messages: conversation,
        };
        const maxTokens =
          selection.outputPolicy.kind === 'exact-token-ceiling'
            ? selection.outputPolicy.maxTokens
            : (options.maxTokens ?? 8192);
        if (options.maxTokens !== undefined && options.maxTokens > maxTokens)
          fail('The reasoning request exceeds its reviewed output-token ceiling.');
        const session = await deps.createSession(
          {
            model,
            systemPrompt:
              (system ||
                'Answer the explicitly requested reasoning phase using only its reviewed context.') +
              (options.responseFormat === 'json' ? '\nReturn only the requested JSON object.' : ''),
            maxTokens,
            tools: [],
            signal,
            async beforeDispatch() {
              signal?.throwIfAborted();
              qualification.assertCurrent();
            },
            ...(selection.thinking ? { reasoningEffort: selection.thinking } : {}),
          },
          request,
          {
            ...input.owner,
            feature: {
              kind: 'paid-reasoning',
              phaseId: input.phasePrefix
                ? `${input.phasePrefix}:${selection.role}`
                : selection.role,
            },
          },
        );
        qualification.assertCurrent();
        signal?.throwIfAborted();
        let content = '',
          inputTokens: number | undefined,
          outputTokens: number | undefined,
          cacheReadTokens: number | undefined,
          cacheCreationTokens: number | undefined;
        for await (const event of session.turn(conversation)) {
          signal?.throwIfAborted();
          qualification.assertCurrent();
          if (
            (event.type === 'content_block_start' && event.content_block.type === 'tool_use') ||
            (event.type === 'message_delta' && event.delta.stop_reason === 'tool_use')
          )
            fail('Paid reasoning phases do not authorize tools.');
          if (event.type === 'content_block_start' && event.content_block.type === 'text')
            content += event.content_block.text;
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta')
            content += event.delta.text;
          if (event.type === 'message_start') {
            if (event.message.model !== model)
              fail('The reasoning provider returned another model.');
            inputTokens = event.message.usage.input_tokens;
            outputTokens = event.message.usage.output_tokens;
            cacheReadTokens = event.message.usage.cache_read_input_tokens;
            cacheCreationTokens = event.message.usage.cache_creation_input_tokens;
          }
          if (event.type === 'message_delta') {
            inputTokens = event.usage.input_tokens ?? inputTokens;
            outputTokens = event.usage.output_tokens;
            cacheReadTokens = event.usage.cache_read_input_tokens ?? cacheReadTokens;
            cacheCreationTokens = event.usage.cache_creation_input_tokens ?? cacheCreationTokens;
          }
          if (content.length > 32768)
            fail('The reasoning phase output exceeded its reviewed text scope.');
        }
        if (
          !content.trim() ||
          inputTokens === undefined ||
          outputTokens === undefined ||
          !Number.isSafeInteger(inputTokens) ||
          !Number.isSafeInteger(outputTokens) ||
          inputTokens < 0 ||
          outputTokens < 0 ||
          inputTokens + outputTokens === 0 ||
          [cacheReadTokens, cacheCreationTokens].some(
            (count) => count !== undefined && (!Number.isSafeInteger(count) || count < 0),
          )
        )
          fail(
            'The reasoning phase did not return verifiable content and real token usage. Inspect its outcome before retrying.',
          );
        if (
          (cacheReadTokens && rate.cacheReadPerMillion === undefined) ||
          (cacheCreationTokens && rate.cacheCreationPerMillion === undefined)
        )
          throw new PaidReasoningUsageCostUnknownError();
        const costUsd =
          (inputTokens * rate.inputPerMillion +
            outputTokens * rate.outputPerMillion +
            (cacheReadTokens ?? 0) * (rate.cacheReadPerMillion ?? 0) +
            (cacheCreationTokens ?? 0) * (rate.cacheCreationPerMillion ?? 0)) /
          1_000_000;
        if (!Number.isFinite(costUsd))
          fail(
            'The configured usage-cost estimate is invalid. Inspect the phase outcome before retrying.',
          );
        return {
          content,
          model,
          usage: {
            inputTokens,
            outputTokens,
            ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
            ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
          },
          costUsd,
        };
      },
    };
  };
  return { selections, routeRevision, createProvider };
}
