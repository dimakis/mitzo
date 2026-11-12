// Native-query boundaries are host events, not provider claims. A provider JSON
// envelope with the same type must never retire another query's child activity.
const retirements = new WeakSet<object>();

export function sdkQueryRetiredEvent(): Record<string, unknown> {
  const event = { type: 'sdk_query_retired' };
  retirements.add(event);
  return event;
}

export function isSdkQueryRetiredEvent(event: object): boolean {
  return retirements.has(event);
}
