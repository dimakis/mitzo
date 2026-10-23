import { TelosWorkLifecycleListSchema } from '@mitzo/protocol';
export function parseTelosCollectionView(value: unknown) {
  const result = TelosWorkLifecycleListSchema.safeParse(value);
  return result.success ? result.data : 'active';
}
export type TelosCollectionView = ReturnType<typeof parseTelosCollectionView>;
export function readTelosCollectionView(state: unknown): TelosCollectionView {
  return parseTelosCollectionView(
    state && typeof state === 'object' && 'telosCollectionView' in state
      ? state.telosCollectionView
      : undefined,
  );
}
export function telosCollectionPath(view: TelosCollectionView): string {
  return view === 'active' ? '/todos' : '/todos?view=' + view;
}
