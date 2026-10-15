import { expect, it } from 'vitest';
import { insertComposerCommand } from '../composer-command';

it('prefixes a command without losing the draft or its line breaks', () => {
  expect(insertComposerCommand('Review this\nand keep the tests', 'simplify')).toBe(
    '/simplify Review this\nand keep the tests',
  );
});
it('replaces only a leading command and preserves all existing arguments', () => {
  expect(insertComposerCommand('/old Review this\nand keep the tests', 'simplify')).toBe(
    '/simplify Review this\nand keep the tests',
  );
  expect(insertComposerCommand('/sim', 'simplify')).toBe('/simplify ');
  expect(insertComposerCommand('Keep /this as text', 'simplify')).toBe(
    '/simplify Keep /this as text',
  );
});
