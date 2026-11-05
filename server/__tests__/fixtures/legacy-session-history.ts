import { sessionHistoryTools } from '../../session-history-tools.js';

/** Keep the original event/summary contract tests while the default tools
 * exercise message retrieval in the composed/native and retrieval suites. */
export function legacySessionHistoryTools(...owners: Parameters<typeof sessionHistoryTools>) {
  const tools = sessionHistoryTools(...owners);
  const execute = tools.execute;
  tools.execute = (name, input, ...context) =>
    execute(
      name,
      {
        ...(name === 'ReadPastSession' ? { view: 'events' } : { scope: 'summaries' }),
        ...input,
      },
      ...context,
    );
  return tools;
}
