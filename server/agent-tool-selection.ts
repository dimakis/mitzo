import { getCredentialConnectionsRuntime } from './credential-connections-runtime.js';
import type { AgentToolReference, SymposiumProfileDefinition } from '@mitzo/protocol';
import { agentToolCatalog } from './agent-tool-catalog.js';

const selections = new WeakMap<object, string | undefined>();
const configuredSelections = new WeakMap<object, string[]>();
export function bindConfiguredAgentTools(
  session: object,
  admitted: { wireName: string; reference: AgentToolReference }[],
): void {
  const refs = JSON.parse(selections.get(session) ?? '[]') as AgentToolReference[];
  if (
    admitted.some(
      (entry) => !refs.some((ref) => JSON.stringify(ref) === JSON.stringify(entry.reference)),
    )
  )
    throw Error('Configured admission differs from published selection');
  const names = admitted.map((entry) => entry.wireName);
  const previous = configuredSelections.get(session);
  if (previous && JSON.stringify(previous) !== JSON.stringify(names))
    throw Error('Session configured selection is immutable');
  configuredSelections.set(session, names);
}
const sdkPrefix = 'mcp__mitzo-connections__';
export function assertAgentToolRoute(
  definition: SymposiumProfileDefinition | undefined,
  route: string,
): void {
  if (definition?.tools === undefined) return;
  if (route !== 'local-api')
    throw Error(
      'Agent tool selection is not supported on this runtime route. Choose a local API chat or a profile with legacy tools.',
    );
  const catalog = agentToolCatalog();
  for (const ref of definition.tools) {
    if (ref.id.startsWith('mcp:')) continue;
    const entry = catalog.find((tool) => tool.id === ref.id && tool.version === ref.version);
    if (!entry?.routes.includes(route))
      throw Error(`Selected tool is unavailable on this route: ${ref.id} v${ref.version}`);
  }
}
/** Capture once from the verified published snapshot, never a mutable editor or client request. */
export function bindAgentToolSelection(
  session: object,
  definition?: SymposiumProfileDefinition,
): void {
  const selection = definition?.tools === undefined ? undefined : JSON.stringify(definition.tools);
  if (selections.has(session) && selections.get(session) !== selection)
    throw Error('Session tool selection is immutable; start a new chat');
  selections.set(session, selection);
}
export function hasAgentToolSelection(session: object): boolean {
  return selections.get(session) !== undefined;
}
export function agentToolAllowed(session: object, name: string): boolean {
  const selection = selections.get(session);
  if (selection === undefined) return true;
  if (configuredSelections.get(session)?.includes(name)) return true;
  const canonical = name.startsWith(sdkPrefix) ? name.slice(sdkPrefix.length) : name;
  const entry = agentToolCatalog().find(
    (tool) => tool.name === canonical && tool.routes.includes('local-api'),
  );
  return (
    !!entry &&
    (entry.required ||
      (JSON.parse(selection) as NonNullable<SymposiumProfileDefinition['tools']>).some(
        (ref) => ref.id === entry.id && ref.version === entry.version,
      ))
  );
}
export function filterAgentTools<T extends { name: string }>(session: object, tools: T[]): T[] {
  return tools.filter((tool) => agentToolAllowed(session, tool.name));
}
export function assertAgentToolSelected(session: object, name: string): void {
  if (!agentToolAllowed(session, name))
    throw Error(`Tool is not selected by this session's published agent profile: ${name}`);
}

/** Connection metadata is eligibility evidence only. Executors still recheck grants at effects. */
export function assertAgentToolAvailability(
  definition: SymposiumProfileDefinition | undefined,
  sessionId: string,
): void {
  if (definition?.tools === undefined) return;
  const names = new Set(definition.tools.map((tool) => tool.id));
  const operations = [
    'ConnectionRequest',
    'ConnectionWebSocket',
    'HomeAssistantDashboard',
    'RequestConnectionAccess',
  ];
  const selected = operations.filter((name) => names.has(`mitzo:${name}`));
  const service = getCredentialConnectionsRuntime();
  if (selected.length) {
    const active =
      service?.catalog(sessionId).filter((connection) => connection.status === 'active') ?? [];
    if (!active.length)
      throw Error(
        `Selected tool ${selected[0]} requires an active connection. Configure it in Connections before starting this chat.`,
      );
    if (
      names.has('mitzo:ConnectionWebSocket') &&
      !active.some((connection) => connection.websocket)
    )
      throw Error('Selected WebSocket tool requires WebSocket access configured in Connections');
    if (
      names.has('mitzo:HomeAssistantDashboard') &&
      !active.some((connection) =>
        ['read', 'read-write'].includes(connection.homeAssistantDashboards ?? 'disabled'),
      )
    )
      throw Error(
        'Selected dashboard tool requires Home Assistant dashboard access configured in Connections',
      );
    if (
      selected.some((name) => name !== 'RequestConnectionAccess') &&
      !names.has('mitzo:RequestConnectionAccess')
    )
      throw Error(
        'Select RequestConnectionAccess alongside connection operations so their existing approval flow can run',
      );
  }
  if (
    !service &&
    ['PrepareConnectionSetup', 'GetConnectionSetup'].some((name) => names.has(`mitzo:${name}`))
  )
    throw Error(
      'Selected connection setup tool requires the existing secure connection runtime to be configured',
    );
}
