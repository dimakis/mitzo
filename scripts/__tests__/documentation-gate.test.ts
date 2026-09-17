import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateDocumentationGate, isProductionPath } from '../documentation-gate.mjs';

const reviewed = '- [x] README reviewed; no update needed';
const exception = 'README exception: This refactor does not affect documented behavior.';

describe('documentation gate', () => {
  it.each([
    ['server/routes.ts', true],
    ['frontend/src/App.tsx', true],
    ['frontend/ios/MitzoShared/Sources/App.swift', true],
    ['packages/client/src/index.ts', true],
    ['packages/harness/src/index.ts', true],
    ['packages/protocol/src/index.ts', true],
    ['mcp-server/src/index.ts', true],
    ['scripts/deploy.sh', true],
    ['infra/openshell/config.yaml', true],
    ['package.json', true],
    ['docker-compose.yml', true],
    ['server/__tests__/routes.test.ts', false],
    ['packages/harness/__tests__/runner.test.ts', false],
    ['frontend/src/App.test.tsx', false],
    ['docs/onboarding.md', false],
  ])('classifies %s as production: %s', (path, expected) => {
    expect(isProductionPath(path)).toBe(expected);
  });

  it('requires an acknowledgement for every PR', () => {
    expect(
      evaluateDocumentationGate({ files: [{ filename: 'docs/onboarding.md' }], body: '' }),
    ).toEqual({
      ok: false,
      errors: ['Complete the README review item in the pull-request template.'],
    });
  });

  it('accepts README changes and either acknowledgement variant', () => {
    for (const body of ['- [x] README updated', reviewed]) {
      expect(
        evaluateDocumentationGate({
          files: [{ filename: 'README.md' }, { filename: 'server/app.ts' }],
          body,
        }),
      ).toEqual({ ok: true, errors: [] });
    }
  });

  it('requires a substantive exception for production changes without README changes', () => {
    expect(
      evaluateDocumentationGate({ files: [{ filename: 'server/app.ts' }], body: reviewed }),
    ).toMatchObject({
      ok: false,
    });
    expect(
      evaluateDocumentationGate({
        files: [{ filename: 'server/app.ts' }],
        body: `${reviewed}\n${exception}`,
      }),
    ).toEqual({ ok: true, errors: [] });
    expect(
      evaluateDocumentationGate({
        files: [{ filename: 'server/app.ts' }],
        body: `${reviewed}\nREADME exception: N/A`,
      }),
    ).toMatchObject({ ok: false });
  });

  it('evaluates the previous path of renamed files', () => {
    expect(
      evaluateDocumentationGate({
        files: [{ filename: 'docs/moved-server.ts', previous_filename: 'server/app.ts' }],
        body: reviewed,
      }),
    ).toMatchObject({ ok: false });
  });

  it('reruns when the PR description is edited', async () => {
    const workflow = await readFile(
      resolve(import.meta.dirname, '../../.github/workflows/ci.yml'),
      'utf8',
    );
    expect(workflow).toContain('types: [opened, synchronize, reopened, edited]');
  });
});
