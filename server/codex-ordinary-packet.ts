import { createHash } from 'node:crypto';
import type { ToolDefinition } from '@mitzo/harness';
import type { WebSearchAccess } from './web-search-policy.js';
import { codexResearchInstructions } from './research-instructions.js';
import {
  codexNativeExecutionParams,
  type CodexNativeExecutionPolicy,
} from './codex-native-execution-policy.js';

/** These are the ordinary owner's resolved host RPC parameters, not the expanded
 * native model prompt. Native instructions, discovered project documents, native
 * tools and provider framing are added inside app-server. Hashing or measuring
 * these host parameters cannot establish exact model context capacity.
 * Callers must resolve current guidance, runtime policy and tools through the
 * ordinary admission owners; these pure serializers grant no execution authority.
 */
export function codexThreadOptions(input: {
  model: string;
  modelProvider: string;
  cwd: string;
  runtimeConfig: Record<string, unknown>;
  webSearch: WebSearchAccess;
  disableProjectDocuments?: boolean;
  systemPrompt: string;
  nativeExecution?: CodexNativeExecutionPolicy;
}) {
  return {
    model: input.model,
    modelProvider: input.modelProvider,
    cwd: input.cwd,
    config: {
      model_reasoning_summary: 'auto',
      ...input.runtimeConfig,
      web_search: input.webSearch,
      ...(input.disableProjectDocuments ? { project_doc_max_bytes: 0 } : {}),
    },
    ...(input.nativeExecution
      ? codexNativeExecutionParams(input.nativeExecution)
      : { approvalPolicy: 'never', sandbox: 'read-only' }),
    developerInstructions: input.systemPrompt + codexResearchInstructions(input.webSearch),
  };
}

export function codexDynamicToolsOption(tools: readonly ToolDefinition[]) {
  return tools.length
    ? {
        dynamicTools: tools.map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          inputSchema: tool.input_schema,
        })),
      }
    : {};
}

export type CodexAdditionalContext = Record<
  string,
  { kind: 'application' | 'untrusted'; value: string }
>;

/** Pinned Codex truncates each additional-context value at 1,000 tokens.
 * UTF-8 byte bounds also bound token count. Version every part together so its
 * BTreeMap merge emits the complete changed selection, including unchanged parts.
 * See openai/codex 79b1b666 context-fragments/src/additional_context.rs and
 * core/src/state/additional_context.rs. No recipe text becomes ordinary user input.
 * This delivery bound does not measure the complete model prompt's capacity.
 */
export function codexApplicationContextFragments(value: string): CodexAdditionalContext {
  const bytes = Buffer.byteLength(value);
  if (bytes > 1048576) throw Error('Application context exceeds the supported delivery bound');
  if (new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(value)) !== value)
    throw Error('Application context contains invalid Unicode');
  if (bytes <= 800) return { 'mitzo.published-project-context': { kind: 'application', value } };
  const parts: string[] = [];
  let part = '',
    size = 0;
  for (const character of value) {
    const length = Buffer.byteLength(character);
    if (size + length > 800) {
      parts.push(part);
      part = '';
      size = 0;
    }
    part += character;
    size += length;
  }
  if (part) parts.push(part);
  const generation = createHash('sha256').update(value).digest('hex');
  return Object.fromEntries(
    parts.map((part, index) => [
      `mitzo.published-project-context.${generation}.${String(index).padStart(6, '0')}`,
      { kind: 'application', value: part },
    ]),
  );
}

/** Used directly by ordinary turn/start; replay text and prepared input order
 * must agree with the actual dispatch. A native capacity continuation carries no
 * replay input and stays under the original continuation owner.
 */
export function codexTurnStartParams(input: {
  threadId: string | undefined;
  commandId: string;
  model: string;
  prompt: string;
  continuation?: boolean;
  attemptContext?: string | null;
  savedSourceContext?: string;
  images?: readonly { mediaType: string; data: string }[];
  reasoningEffort?: string | null;
  sandboxPolicy?: Record<string, unknown>;
  additionalContext: CodexAdditionalContext;
  nativeExecution?: CodexNativeExecutionPolicy;
}) {
  return {
    threadId: input.threadId,
    clientUserMessageId: input.commandId,
    model: input.model,
    input: input.continuation
      ? []
      : [
          ...(input.attemptContext ? [{ type: 'text', text: input.attemptContext }] : []),
          ...(input.savedSourceContext ? [{ type: 'text', text: input.savedSourceContext }] : []),
          { type: 'text', text: input.prompt },
          ...(input.images ?? []).map((image) => ({
            type: 'image',
            url: `data:${image.mediaType};base64,${image.data}`,
          })),
        ],
    ...(input.nativeExecution
      ? codexNativeExecutionParams(input.nativeExecution)
      : { approvalPolicy: 'never', sandboxPolicy: input.sandboxPolicy ?? { type: 'readOnly' } }),
    ...(input.reasoningEffort ? { effort: input.reasoningEffort } : {}),
    ...(Object.keys(input.additionalContext).length
      ? { additionalContext: input.additionalContext }
      : {}),
  };
}
