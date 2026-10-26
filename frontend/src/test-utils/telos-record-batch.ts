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
