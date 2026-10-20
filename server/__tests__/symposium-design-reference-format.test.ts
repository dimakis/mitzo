import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getFileInfo } from 'prettier';
import { expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const reference = 'docs/design/approved/symposium/fresh-agent-review.html';
const options = { ignorePath: resolve(root, '.prettierignore') };

it('preserves the original approved reference bytes outside automatic formatting', async () => {
  expect(await getFileInfo(resolve(root, reference), options)).toMatchObject({ ignored: true });
  expect(
    createHash('sha256')
      .update(readFileSync(resolve(root, reference)))
      .digest('hex'),
  ).toBe('175e801ff2acd66cd8d176d56bd389da9439d75a4cf061e214b4220357894bbc');
});

it.each([
  'frontend/src/components/ConversationAgents.tsx',
  'tests/offline/symposium-approved-design.spec.ts',
  'docs/design/approved/symposium/test-syntax-approval-2026-10-18.md',
])('keeps editable source and approval evidence in formatting coverage: %s', async (path) => {
  expect(await getFileInfo(resolve(root, path), options)).toMatchObject({ ignored: false });
});
