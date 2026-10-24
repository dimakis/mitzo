import { randomUUID } from 'node:crypto';
import type { CodexLifecycleTransport } from '../../codex-app-server-client.js';

type Input = Record<string, unknown>;
type Actor = {
  tools: ReadonlyArray<{ name: string }>;
  threadId: string;
  turnId: string;
  lifecycle: Pick<CodexLifecycleTransport, 'onRequest'>;
};
type Contract = {
  name: string;
  toolId: string;
  catalogRevision: string;
  inputSchema: Input;
};

/** External provider input only. Discovery, authority and effects all run through
 * the admitted App actor's real lifecycle. Never synthesize a deferred registry,
 * opaque toolId or revision, or fall back to a directly invoked MCP name.
 * Kept under server test fixtures so canonical tests retain their rootDir.
 */
export async function prepareNativeProviderToolCall(
  actor: Actor,
  name: string,
  args: Input,
  callId = randomUUID(),
) {
  const request = (tool: string, arguments_: Input, id: string) => ({
    threadId: actor.threadId,
    turnId: actor.turnId,
    callId: id,
    tool,
    arguments: arguments_,
  });
  const definition = (tool: string) => {
    const found = actor.tools.find((entry) => entry.name === tool);
    if (!found) throw Error('Actual provider definition unavailable: ' + tool);
    return found.name;
  };
  const discovery: Array<{ request: Input; result: unknown }> = [];
  const read = async (tool: string, input: Input): Promise<Input> => {
    const call = request(definition(tool), input, randomUUID());
    const result = await actor.lifecycle.onRequest(
      'item/tool/call',
      call,
      new AbortController().signal,
    );
    discovery.push({ request: call, result });
    if (result.success !== true || !Array.isArray(result.contentItems))
      throw Error('Actual integration discovery failed: ' + JSON.stringify(result));
    const text = result.contentItems.map((item) => (item as { text?: string }).text ?? '').join('');
    const value = JSON.parse(text) as Input;
    if (value.error) throw Error('Actual integration discovery error: ' + text);
    return value;
  };
  if (!name.startsWith('mcp__'))
    return { request: request(definition(name), args, callId), discovery };

  const invoke = definition('InvokeIntegrationTool');
  let listed: Input | undefined;
  let catalogRevision: unknown;
  let offset = 0;
  do {
    const page = await read('ListIntegrationTools', { query: name, offset, limit: 20 });
    if (catalogRevision !== undefined && catalogRevision !== page.catalogRevision)
      throw Error('Integration catalog changed during discovery');
    catalogRevision = page.catalogRevision;
    listed = (page.tools as Input[]).find((tool) => tool.name === name);
    if (listed || page.nextOffset === null) break;
    if (!Number.isInteger(page.nextOffset) || Number(page.nextOffset) <= offset)
      throw Error('Invalid integration catalog pagination');
    offset = Number(page.nextOffset);
  } while (offset <= 1000);
  if (!listed || typeof listed.toolId !== 'string')
    throw Error('Actual selected integration unavailable: ' + name);
  let described = await read('DescribeIntegrationTool', { toolId: listed.toolId });
  let fragments = '';
  while (described.format === 'json-fragment') {
    if (
      described.toolId !== listed.toolId ||
      described.catalogRevision !== catalogRevision ||
      described.offset !== fragments.length ||
      typeof described.contractFragment !== 'string' ||
      !described.contractFragment.length
    )
      throw Error('Invalid integration contract fragment');
    fragments += described.contractFragment;
    if (described.nextOffset === null) {
      if (described.totalCharacters !== fragments.length)
        throw Error('Incomplete integration contract');
      described = JSON.parse(fragments) as Input;
      break;
    }
    if (described.nextOffset !== fragments.length || fragments.length > 1048576)
      throw Error('Invalid integration contract continuation');
    described = await read('DescribeIntegrationTool', {
      toolId: listed.toolId,
      offset: described.nextOffset,
    });
  }
  if (
    described.name !== name ||
    described.toolId !== listed.toolId ||
    described.catalogRevision !== catalogRevision ||
    typeof catalogRevision !== 'string' ||
    !described.inputSchema ||
    typeof described.inputSchema !== 'object'
  )
    throw Error('Actual integration contract identity/schema mismatch: ' + name);
  const contract = described as Contract;
  return {
    request: request(
      invoke,
      {
        toolId: contract.toolId,
        catalogRevision: contract.catalogRevision,
        arguments: args,
      },
      callId,
    ),
    contract,
    discovery,
  };
}
