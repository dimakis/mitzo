import type { createJoinedOrdinaryApplication } from '../integrated-candidate/joined-ordinary-application';

export const selectedModel = 'fixture-model';
const alternateModel = 'fixture-unselected-catalog-model';
type InventoryPhase = 'initial' | 'unavailable' | 'restored';

/** External provider metadata only. Never a catalog/cache/admission replacement. */
export function createExternalInventory() {
  let phase: InventoryPhase = 'initial';
  const observations: Array<{ phase: InventoryPhase; params: unknown; response: unknown }> = [];
  return {
    alternateModel,
    setPhase(next: InventoryPhase) {
      phase = next;
    },
    observations: () => structuredClone(observations),
    modelList(params?: Record<string, unknown>) {
      const model = phase === 'unavailable' ? alternateModel : selectedModel;
      const response = {
        data: [
          {
            model,
            displayName: 'Synthetic metadata only',
            supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
          },
        ],
        nextCursor: null,
      };
      observations.push({
        phase,
        params: structuredClone(params),
        response: structuredClone(response),
      });
      return response;
    },
  };
}

/** Initial canonical synthetic data before App imports, never post-start SQL. */
export const initializeReadinessData: NonNullable<
  Parameters<typeof createJoinedOrdinaryApplication>[1]
> = ({ canonical }) => {
  canonical.db
    .prepare(
      `INSERT INTO items
    (id,summary,intent,rationale,acceptance_criteria,profile,priority,parent_id,
     context_hints,first_seen,last_seen,created_at,updated_at)
    VALUES('recording-slice','Record one acoustic sample','Retain one reviewed sample',
      'Exact smallest child only','["Retain sample evidence"]','manual',7,'studio','{}',?,?,?,?)`,
    )
    .run(canonical.stamp, canonical.stamp, canonical.stamp, canonical.stamp);
  canonical.db
    .prepare(
      `INSERT INTO history(item_id,old_status,new_status,changed_at)
    VALUES('recording-slice',NULL,'active',?)`,
    )
    .run(canonical.stamp);
};
