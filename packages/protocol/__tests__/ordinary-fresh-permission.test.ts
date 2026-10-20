import { describe, expect, it } from 'vitest';
import {
  createOrdinaryFreshPermission,
  OrdinaryLocalCommandSelectionSchema,
} from '../src/ordinary-local-admission.js';

describe('ordinary fresh permission construction', () => {
  it.each(['ask', 'agent', 'auto'] as const)(
    'uses the actual fresh %s selection with revision zero',
    (mode) => {
      const permission = createOrdinaryFreshPermission(mode);
      expect(permission).toStrictEqual({ mode, revision: 0 });
      expect(OrdinaryLocalCommandSelectionSchema.shape.permission.parse(permission)).toEqual(
        permission,
      );
      expect(Object.keys(permission).sort()).toEqual(['mode', 'revision']);
    },
  );

  it.each([
    '',
    'ASK',
    'bypass',
    null,
    undefined,
    0,
    {},
    ['agent'],
    { mode: 'ask', revision: 0 },
    { mode: 'auto', revision: 9, authorized: true },
  ])('refuses malformed mode or a caller-supplied permission/grant object %j', (mode) => {
    expect(() => createOrdinaryFreshPermission(mode as never)).toThrow();
  });

  it('preserves the existing selection schema for recorded nonfresh permission revisions', () => {
    const recorded = { mode: 'agent' as const, revision: 7 };
    expect(OrdinaryLocalCommandSelectionSchema.shape.permission.parse(recorded)).toStrictEqual(
      recorded,
    );
  });

  it('does not inherit a caller mutation or previous permission revision', () => {
    const previous = createOrdinaryFreshPermission('ask');
    Object.assign(previous, { mode: 'auto', revision: 8 });
    expect(createOrdinaryFreshPermission('ask')).toStrictEqual({ mode: 'ask', revision: 0 });
    expect(createOrdinaryFreshPermission('auto')).toStrictEqual({ mode: 'auto', revision: 0 });
  });
});
