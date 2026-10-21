import type { z } from 'zod';
import { TelosWorkLifecycleListSchema } from '@mitzo/protocol';
import type { TodoListResponse } from './api-schemas.js';
import { isAuthSessionCurrent, type AuthSession } from './auth.js';
import { TelosWorkError, TelosWorkStore } from './telos-work-store.js';
import { collectTelosCanonicalItemIds, projectTelosLifecycleTree } from './telos-lifecycle-tree.js';

/** Compose the existing authenticated canonical read with its selected database.
 * Undefined operator means the upstream-authenticated internal active reader;
 * it never becomes operator authority for archive/trash, history or mutations.
 */
export function projectCanonicalTelosLifecycleList(input: {
  canonical: z.output<typeof TodoListResponse>;
  databasePath: string;
  view: unknown;
  operator: AuthSession | undefined;
  policy: ConstructorParameters<typeof TelosWorkStore>[1];
}): z.output<typeof TodoListResponse> {
  const parsed = TelosWorkLifecycleListSchema.safeParse(input.view);
  if (!parsed.success) throw new TelosWorkError('invalid', 'Invalid lifecycle view');
  const view = parsed.data;
  const operator = input.operator;
  if (operator && (!operator.id.trim() || !isAuthSessionCurrent(operator)))
    throw new TelosWorkError('unauthorized', 'Current interactive operator required');
  if (view !== 'active' && !operator)
    throw new TelosWorkError('unauthorized', 'Current interactive operator required');
  const ids = collectTelosCanonicalItemIds(input.canonical);
  // Read committed initialized authority without contending with its writer.
  // The first list still initializes genuinely missing additive schema.
  const work = TelosWorkStore.openForLifecycleListRead(input.databasePath, input.policy);
  try {
    if (view === 'active')
      return projectTelosLifecycleTree(
        input.canonical,
        work.lifecycleVisibilityForCanonicalList(ids),
        view,
      );
    if (!operator)
      throw new TelosWorkError('unauthorized', 'Current interactive operator required');
    return projectTelosLifecycleTree(
      input.canonical,
      work.listLifecycle(view, { kind: 'operator', id: operator.id }),
      view,
    );
  } finally {
    work.close();
  }
}
