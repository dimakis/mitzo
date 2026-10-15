import type { SymposiumProfileDefinition } from '@mitzo/protocol';
import { agentToolCatalog } from './agent-tool-catalog.js';

const selections = new WeakMap<object, string | undefined>();
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
