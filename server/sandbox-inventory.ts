export interface PhysicalSandboxInventoryItem {
  id: string;
  name: string;
  phase: string;
}

/** Gateway observations, not ledger length, define physical resource counts.
 * A name alone is never enough to authorize management of a replacement. */
export function summarizeSandboxInventory(
  physical: PhysicalSandboxInventoryItem[],
  conversations: Array<{ physicalId?: string | null; sandboxName: string }>,
  spares: Array<{ physicalId: string | null; name: string }>,
) {
  const counts: Record<string, number> = {};
  const items = [...new Map(physical.map((item) => [item.id, item])).values()].map((item) => {
    counts[item.phase] = (counts[item.phase] ?? 0) + 1;
    const management = conversations.some(
      (r) => r.physicalId === item.id && r.sandboxName === item.name,
    )
      ? 'conversation'
      : spares.some((r) => r.physicalId === item.id && r.name === item.name)
        ? 'spare'
        : 'needs_review';
    return { id: item.id, name: item.name, state: item.phase, management };
  });
  return { available: true as const, observedAt: Date.now(), total: items.length, counts, items };
}
