import { Buffer } from 'node:buffer';
import { posix } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
const refuse = (detail) => Error('Actual retained native import closure unavailable: ' + detail);
const sha = (value) => createHash('sha256').update(value).digest('hex');
/** Read-only source analysis. Native roots and the single excluded app-fork
 * boundary are fixed by reviewed code. This is compatibility data, never a
 * model/account/provisioning certificate or process-local ownership grant. */
export function deriveRetainedNativeImportClosure({ readModule }) {
  if (typeof readModule !== 'function') throw refuse('actual immutable module reader required');
  const modules = new Map(),
    external = new Set();
  let totalBytes = 0,
    childForks = 0;
  const visit = (path) => {
    if (modules.has(path)) return;
    if (modules.size >= 2048 || !/^dist\/[A-Za-z0-9_./-]+\.js$/.test(path) || path.includes('/../'))
      throw refuse('unbounded or escaped module ' + path);
    const text = readModule(path);
    if (typeof text !== 'string' || (totalBytes += Buffer.byteLength(text)) > 32 * 1024 * 1024)
      throw refuse('bounded actual JS bytes required');
    modules.set(path, sha(text));
    const parsed = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (parsed.parseDiagnostics.length) throw refuse('invalid compiled module ' + path);
    const literal = (node) => (node && ts.isStringLiteralLike(node) ? node.text : undefined);
    const dependency = (specifier) => {
      if (!specifier) throw refuse('computed import in ' + path);
      if (specifier.startsWith('node:')) return;
      if (specifier.startsWith('.')) {
        const next = posix.normalize(posix.join(posix.dirname(path), specifier));
        if (!next.startsWith('dist/') || !next.endsWith('.js'))
          throw refuse('unknown relative module ' + specifier);
        visit(next);
      } else if (
        /^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?$/.test(specifier)
      ) {
        external.add(
          specifier.startsWith('@')
            ? specifier.split('/').slice(0, 2).join('/')
            : specifier.split('/')[0],
        );
      } else throw refuse('unknown external module ' + specifier);
    };
    const asset = (specifier) => {
      if (typeof specifier !== 'string' || !specifier.startsWith('.'))
        throw refuse('unknown asset ' + path);
      const next = posix.normalize(posix.join(posix.dirname(path), specifier));
      if (
        !/^(?:dist|server|content|docs|infra|scripts)\/[A-Za-z0-9_./-]+$/.test(next) ||
        next.includes('/../') ||
        next.includes('/./')
      )
        throw refuse('escaped asset ' + specifier);
      if (next.endsWith('.js')) return dependency(specifier);
      if (modules.has(next)) return modules.get(next);
      if (modules.size >= 2048) throw refuse('unbounded assets');
      const body = readModule(next);
      if (typeof body !== 'string' || (totalBytes += Buffer.byteLength(body)) > 32 * 1024 * 1024)
        throw refuse('bounded actual asset bytes required');
      modules.set(next, sha(body));
      return modules.get(next);
    };
    const providerAssets = (node) => {
      if (
        path !== 'dist/openshell-runtime-policy.js' ||
        node.arguments?.[0]?.getText(parsed) !== 'pin[0]'
      )
        throw refuse('computed asset URL in ' + path);
      let owner = node.parent;
      while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent;
      if (!owner?.body || owner.name?.text !== 'reviewedRuntimeProfile')
        throw refuse('unknown finite provider asset owner');
      const declarations = owner.body.statements
        .filter(ts.isVariableStatement)
        .flatMap((statement) => [...statement.declarationList.declarations]);
      const pins = declarations.filter((d) => ts.isIdentifier(d.name) && d.name.text === 'pins');
      const selected = declarations.filter((d) => ts.isIdentifier(d.name) && d.name.text === 'pin');
      if (
        pins.length !== 1 ||
        selected.length !== 1 ||
        !ts.isObjectLiteralExpression(pins[0].initializer) ||
        selected[0].initializer?.getText(parsed) !== 'pins[type]' ||
        pins[0].initializer.properties.length < 1 ||
        pins[0].initializer.properties.length > 20
      )
        throw refuse('unknown finite provider asset map');
      const names = new Set();
      for (const entry of pins[0].initializer.properties) {
        if (
          !ts.isPropertyAssignment(entry) ||
          !entry.name ||
          ts.isComputedPropertyName(entry.name) ||
          !ts.isArrayLiteralExpression(entry.initializer) ||
          entry.initializer.elements.length !== 2
        )
          throw refuse('nonliteral provider asset map');
        const name =
            literal(entry.name) ?? (ts.isIdentifier(entry.name) ? entry.name.text : undefined),
          values = entry.initializer.elements;
        if (
          !name ||
          names.has(name) ||
          !literal(values[0]) ||
          !/^[a-f0-9]{64}$/.test(literal(values[1]) ?? '')
        )
          throw refuse('nonliteral provider asset pin');
        names.add(name);
        if (asset(literal(values[0])) !== literal(values[1]))
          throw refuse('physical provider asset differs from its literal pin');
      }
    };
    const walk = (node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier) dependency(literal(node.moduleSpecifier));
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        if (node.arguments.length !== 1) throw refuse('unknown import arity ' + path);
        dependency(literal(node.arguments[0]));
      }
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'URL'
      ) {
        const args = node.arguments ?? [],
          target = literal(args[0]),
          base = args[1]?.getText(parsed);
        if (
          target === './index.js' &&
          path === 'dist/symposium-custodian-main.js' &&
          base === 'import.meta.url' &&
          node.parent &&
          ts.isCallExpression(node.parent) &&
          ts.isIdentifier(node.parent.expression) &&
          node.parent.expression.text === 'fork'
        ) {
          if (++childForks > 1) throw refuse('second app fork boundary');
        } else if (base === 'import.meta.url' && target) {
          asset(target);
        } else if (base === 'import.meta.url') providerAssets(node);
        // Other URLs are network/address data. Computed import()/require() are
        // independently refused above; these expressions grant no code loader.
      }
      ts.forEachChild(node, walk);
    };
    walk(parsed);
  };
  visit('dist/symposium-custodian-main.js');
  const result = {
    version: 1,
    modules: [...modules]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, sha256]) => Object.freeze({ path, sha256 })),
    externalPackages: [...external].sort(),
    appForkBoundary: 'dist/index.js',
  };
  return Object.freeze({
    ...result,
    modules: Object.freeze(result.modules),
    externalPackages: Object.freeze(result.externalPackages),
    sha256: sha(JSON.stringify(result)),
  });
}
