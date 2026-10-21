import { TelosWorkLifecycleViewSchema } from '@mitzo/protocol';
export function createTelosLifecycleFixture(
  stage: 'running' | 'requested' | 'acknowledged' | 'applied' = 'running',
  disposition: 'active' | 'archived' | 'trashed' = 'active',
  itemId = 'selected',
) {
  const controls =
    stage === 'running'
      ? []
      : (['new_worker_dispatch', 'safe_point', 'publication'] as const).map((scope) => ({
          version: 1,
          controlId: 'pause-' + scope,
          coordinatorItemId: itemId,
          coordinatorConversationId: null,
          priorityItemId: null,
          origin: 'operator_pause',
          scope,
          stage,
          publicationRevalidation: 'not_applicable',
          targets: [
            {
              itemId,
              leadConversationId: 'selected-lead',
              assignmentRevision: 1,
              stage,
              workers: [],
            },
          ],
          history:
            stage === 'requested'
              ? []
              : [
                  {
                    eventId: 'evidence-' + scope,
                    itemId,
                    role: 'lead',
                    conversationId: 'selected-lead',
                    assignmentRevision: 1,
                    stage,
                    evidenceRef: 'verified-' + scope,
                  },
                ],
        }));
  return TelosWorkLifecycleViewSchema.parse({
    itemId,
    revision: 'a'.repeat(64),
    disposition,
    effectiveDisposition: disposition,
    inheritedFrom: null,
    pause: { stage, controls },
    history: [],
  });
}
