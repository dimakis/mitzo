import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { localRepositoryToolSchemas } from './session-local-repository-tools.js';
import { inputSchema } from './local-repository-preparation-input.js';
import { freezePendingHostTaskData } from './pending-host-task.js';

const prefix = 'mcp__mitzo-connections__';
const schemas = { ...localRepositoryToolSchemas, PrepareLocalRepository: inputSchema };
const reference = (value: unknown): value is string =>
  typeof value === 'string' && /^\S{1,200}$/.test(value);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function parsed(name: string, raw: unknown) {
  if (!name.startsWith(prefix) || !Object.hasOwn(schemas, name.slice(prefix.length)))
    throw Error('Original SDK repository tool required');
  return schemas[name.slice(prefix.length) as keyof typeof schemas].parse(raw);
}
export interface SdkRepositoryCallback {
  readonly queryId: string;
  readonly commandId: string;
  readonly toolUseId: string;
  readonly mcpRequestId: string;
  readonly sdkSessionId: string;
  readonly cwd: string;
  readonly toolName: string;
  readonly requestHash: string;
  readonly input: ReturnType<typeof parsed>;
  readonly signal: AbortSignal;
  assertCurrent(): void;
}
const originalCallbacks = new WeakSet<object>();
export function assertSdkRepositoryCallback(value: SdkRepositoryCallback) {
  if (!originalCallbacks.has(value)) throw Error('Original SDK repository callback required');
  value.assertCurrent();
}

/** Ephemeral provenance on ONE existing SDK query. No permission, repository,
 * dispatch, durable queue or session store. Only the query's original hook may
 * observe a tool-use ID; MCP request IDs never impersonate provider identities. */
export function createSdkRepositoryCallbacks(owner: {
  commandId(): string | undefined;
  assertCurrent(): void;
  checkTool(name: string): 'allow' | 'deny';
}) {
  const queryId = randomUUID();
  const originalCurrent = owner.assertCurrent,
    originalCommand = owner.commandId,
    originalTool = owner.checkTool;
  const observed = new Map<
    string,
    {
      commandId: string;
      sdkSessionId: string;
      cwd: string;
      name: string;
      input: ReturnType<typeof parsed>;
      requestHash: string;
      claimed: boolean;
    }
  >();
  const current = (name: string) => {
    if (
      owner.assertCurrent !== originalCurrent ||
      owner.commandId !== originalCommand ||
      owner.checkTool !== originalTool
    )
      throw Error('Original SDK callback owner changed');
    const result: unknown = originalCurrent.call(owner);
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => {});
      throw Error('Synchronous original SDK callback owner required');
    }
    const commandId = originalCommand.call(owner);
    if (!reference(commandId)) throw Error('Original SDK command unavailable');
    if (originalTool.call(owner, name) !== 'allow')
      throw Error('Original SDK command tool ceiling refused');
    return commandId;
  };
  return Object.freeze({
    observe(raw: unknown) {
      if (!raw || typeof raw !== 'object') return;
      const input = raw as Record<string, unknown>;
      if (
        input.hook_event_name !== 'PreToolUse' ||
        typeof input.tool_name !== 'string' ||
        !input.tool_name.startsWith(prefix) ||
        !Object.hasOwn(schemas, input.tool_name.slice(prefix.length))
      )
        return;
      const commandId = current(input.tool_name);
      if (
        !reference(input.tool_use_id) ||
        !reference(input.session_id) ||
        typeof input.cwd !== 'string' ||
        !input.cwd.startsWith('/') ||
        input.agent_id !== undefined ||
        input.parent_tool_use_id != null
      )
        throw Error('Original ordinary SDK repository hook required');
      const args = parsed(input.tool_name, input.tool_input);
      const value = {
        commandId,
        sdkSessionId: input.session_id,
        cwd: input.cwd,
        name: input.tool_name,
        input: structuredClone(args),
        requestHash: hash(args),
        claimed: false,
      };
      const previous = observed.get(input.tool_use_id);
      if (previous) {
        if (!isDeepStrictEqual({ ...previous, claimed: false }, value))
          throw Error('Original SDK tool-use identity changed');
        return;
      }
      if (observed.size >= 64) throw Error('SDK repository callback bound exceeded');
      observed.set(input.tool_use_id, value);
    },
    capture(
      name: string,
      raw: unknown,
      requestId: unknown,
      signal: AbortSignal,
    ): Readonly<SdkRepositoryCallback> {
      signal.throwIfAborted();
      const commandId = current(name);
      const mcpRequestId =
        typeof requestId === 'number' && Number.isSafeInteger(requestId)
          ? String(requestId)
          : requestId;
      if (!reference(mcpRequestId)) throw Error('Original MCP request identity required');
      const input = parsed(name, raw),
        requestHash = hash(input);
      const candidates = [...observed].filter(
        ([, call]) =>
          !call.claimed &&
          call.commandId === commandId &&
          call.name === name &&
          call.requestHash === requestHash,
      );
      if (candidates.length !== 1)
        throw Error('Missing or ambiguous original SDK tool-use identity');
      const [toolUseId, call] = candidates[0];
      call.claimed = true;
      const result = Object.freeze({
        queryId,
        commandId,
        toolUseId,
        mcpRequestId,
        sdkSessionId: call.sdkSessionId,
        cwd: call.cwd,
        toolName: name.slice(prefix.length),
        requestHash,
        input: freezePendingHostTaskData(structuredClone(input)),
        signal,
        assertCurrent() {
          signal.throwIfAborted();
          if (current(name) !== commandId || observed.get(toolUseId) !== call || !call.claimed)
            throw Error('Original SDK repository callback unavailable');
        },
      });
      originalCallbacks.add(result);
      return result;
    },
  });
}
