import { expect, it } from 'vitest';
import { buildSymposiumContextPackage } from '../symposium-context-package.js';
const turns = [
  { id: 'public', content: 'Approved task', shareable: true },
  { id: 'private', content: 'Private aside', shareable: false },
];
it('independent context never includes history', () => {
  expect(buildSymposiumContextPackage({ mode: 'independent' }, turns)).toBe('');
});
it('full context includes only explicitly shareable completed turns', () => {
  expect(buildSymposiumContextPackage({ mode: 'full-context' }, turns)).toContain('Approved task');
  expect(buildSymposiumContextPackage({ mode: 'full-context' }, turns)).not.toContain(
    'Private aside',
  );
});
it('rejects private, unknown and empty selected turns without silently expanding scope', () => {
  for (const turnIds of [[], ['private'], ['missing']])
    expect(() =>
      buildSymposiumContextPackage({ mode: 'selected-turns', turnIds }, turns),
    ).toThrow();
  expect(
    buildSymposiumContextPackage({ mode: 'selected-turns', turnIds: ['public'] }, turns),
  ).toContain('Approved task');
});
it('summary is explicit operator text, never an implicit model or transcript call', () => {
  expect(
    buildSymposiumContextPackage({ mode: 'summary', summary: 'Only this summary' }, turns),
  ).toContain('Only this summary');
  expect(
    buildSymposiumContextPackage({ mode: 'summary', summary: 'Only this summary' }, turns),
  ).not.toContain('Approved task');
  expect(() => buildSymposiumContextPackage({ mode: 'summary' }, turns)).toThrow();
});
