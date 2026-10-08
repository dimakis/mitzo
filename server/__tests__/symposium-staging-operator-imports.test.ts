import { expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

const entries = [
  'scripts/symposium-staging-transition.mjs',
  'scripts/symposium-staging.mjs',
  'scripts/prepare-staging-service.mjs',
  'scripts/lib/symposium-staging-router.mjs',
];
function closure() {
  const pending = entries.map((path) => resolve(path)),
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
    const add = (specifier: ts.Expression | undefined) => {
      if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) return;
      let target = resolve(dirname(path), specifier.text);
      const dist = resolve('dist') + '/';
      if (target.startsWith(dist))
        target = resolve('server', target.slice(dist.length).replace(/\.js$/, '.ts'));
      else if (target.endsWith('.js')) target = target.slice(0, -3) + '.ts';
      if (existsSync(target)) pending.push(target);
      else throw Error('Missing operator dependency: ' + target);
    };
    for (const node of source.statements) {
      if (ts.isImportDeclaration(node)) {
        if (node.importClause?.isTypeOnly) continue;
        const bindings = node.importClause?.namedBindings;
        if (
          bindings &&
          ts.isNamedImports(bindings) &&
          bindings.elements.length &&
          bindings.elements.every((x) => x.isTypeOnly)
        )
          continue;
        add(node.moduleSpecifier);
      } else if (ts.isExportDeclaration(node) && !node.isTypeOnly) add(node.moduleSpecifier);
    }
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
        add(node.arguments[0]);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...seen].map((path) => path.slice(resolve('.').length + 1));
}
it('closes the actual operator entrypoints through pure contracts without native custody or app imports', () => {
  const paths = closure();
  expect(paths).toContain('server/symposium-staging-launch-schema.ts');
  expect(paths).toContain('server/symposium-canonical-control.ts');
  for (const path of [
    'server/app.ts',
    'server/symposium-custodian-main.ts',
    'server/symposium-staging-launch.ts',
    'server/symposium-staging-registry.ts',
    'server/symposium-owned-host.ts',
    'server/symposium-owned-gateway.ts',
    'server/symposium-criterion-receipts.ts',
    'server/symposium-session-runtime.ts',
  ])
    expect(paths).not.toContain(path);
});
