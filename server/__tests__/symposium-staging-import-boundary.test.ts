import { expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

const roots = [
  'symposium-owned-release',
  'symposium-staging-service',
  'symposium-canonical-owner-record',
  'symposium-canonical-control',
  'symposium-custodian-retirement',
  'symposium-staging-runtime-contract',
  'symposium-criterion-definition',
];
function runtimeClosure() {
  const pending = roots.map((name) => resolve('server', name + '.ts')),
    seen = new Set<string>();
  while (pending.length) {
    const path = pending.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const node of source.statements) {
      let specifier: ts.Expression | undefined;
      if (ts.isImportDeclaration(node)) {
        if (node.importClause?.isTypeOnly) continue;
        const bindings = node.importClause?.namedBindings;
        if (
          bindings &&
          ts.isNamedImports(bindings) &&
          bindings.elements.length &&
          bindings.elements.every((binding) => binding.isTypeOnly)
        )
          continue;
        specifier = node.moduleSpecifier;
      } else if (ts.isExportDeclaration(node) && !node.isTypeOnly) specifier = node.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) continue;
      const target = join(dirname(path), specifier.text.replace(/\.js$/, '.ts'));
      if (existsSync(target)) pending.push(target);
    }
  }
  return [...seen].map((path) => path.slice(resolve('server').length + 1)).sort();
}
it('keeps the static foundation runtime closure out of app, native launch, provider execution and protocol code', () => {
  const closure = runtimeClosure();
  expect(closure).toContain('symposium-staging-launch-schema.ts');
  expect(closure).toContain('symposium-staging-runtime-contract.ts');
  expect(closure).toContain('symposium-criterion-definition.ts');
  for (const name of [
    'app.ts',
    'symposium-custodian-main.ts',
    'symposium-staging-launch.ts',
    'symposium-staging-registry.ts',
    'symposium-owned-host.ts',
    'symposium-owned-gateway.ts',
    'symposium-criterion-receipts.ts',
    'symposium-session-runtime.ts',
    'symposium-review-coordinator.ts',
    'symposium-codex-native.ts',
    'symposium-claude-native.ts',
  ])
    expect(closure).not.toContain(name);
});
