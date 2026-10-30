/** Adapt existing per-item offline gates/errors to the collection wire contract. */
export async function telosRecordBatchFixture(
  init: RequestInit | undefined,
  read: (id: string) => Promise<Response>,
) {
  const { itemIds } = JSON.parse(String(init?.body)) as { itemIds: string[] };
  const results = await Promise.all(
    itemIds.map(async (itemId) => {
      const response = await read(itemId);
      return response.ok
        ? { record: await response.json() }
        : {
            failure: {
              itemId,
              code: response.status === 404 ? 'not_found' : 'record_read_failed',
              status: response.status,
            },
          };
    }),
  );
  return Response.json({
    records: results.flatMap((r) => (r.record ? [r.record] : [])),
    failures: results.flatMap((r) => (r.failure ? [r.failure] : [])),
  });
}

/** Compatibility transport for approved tests whose synthetic server supplies
 * legacy trees and exact canonical records. Production never uses this adapter.
 * Native wire call budgets are asserted by telos-first-use.spec.ts instead. */
export async function telosCollectionFixture(
  readList: () => Promise<Response>,
  readRecord: (id: string) => Promise<Response>,
) {
  const list = await readList();
  if (!list.ok) return list;
  const data = await list.json();
  const ids = new Set<string>();
  function visit(items: { id: string; children?: { id: string }[] }[]) {
    for (const item of items) {
      ids.add(item.id);
      visit(item.children ?? []);
    }
  }
  visit(data.items ?? []);
  const result = await telosRecordBatchFixture(
    { body: JSON.stringify({ itemIds: [...ids] }) },
    readRecord,
  );
  const batch = await result.json();
  if (ids.size && !batch.records.length)
    return Response.json({ error: 'Canonical records unavailable' }, { status: 503 });
  return Response.json({ ...batch, profiles: data.profiles ?? [] });
}
