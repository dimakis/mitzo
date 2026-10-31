import { posix } from 'node:path';

export function boundedReviewDependencyCandidates(candidates: Set<string>, remaining: number) {
  const paths = [...candidates].slice(0, Math.max(0, remaining));
  return { paths, omittedCount: candidates.size - paths.length };
}

function addRelativeTarget(targets: Set<string>, path: string, relative: string, all: Set<string>) {
  const target = posix.normalize(posix.join(posix.dirname(path), relative));
  if (all.has(target)) targets.add(target);
  return target;
}

/** Discovery only: literal references in committed text never execute or grant
 * authority. Every returned candidate must also exist in the pinned Git tree. */
export function publicationReviewImports(path: string, content: string, all: Set<string>) {
  const targets = new Set<string>();
  for (const match of content.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\(|\bimport\s*)['"]([^'"\n]+)['"]/g,
  )) {
    if (!match[1].startsWith('.')) continue;
    const target = addRelativeTarget(targets, path, match[1], all);
    const stem = target.replace(/\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/, '');
    for (const extension of [
      '.ts',
      '.tsx',
      '.js',
      '.mts',
      '.mjs',
      '.cts',
      '.cjs',
      '/index.ts',
      '/index.tsx',
      '/index.js',
    ])
      if (all.has(stem + extension)) targets.add(stem + extension);
  }
  return targets;
}

/** Requested full-file reads additionally discover the narrowly recognized
 * shell delegation convention. Initial automatic discovery keeps its prior scope. */
export function publicationReviewDependencies(path: string, content: string, all: Set<string>) {
  const targets = publicationReviewImports(path, content, all);
  if (!/\.(?:sh|bash)$/.test(path)) return targets;
  // Recognize only this literal script-directory binding, without interpreting
  // shell expansions. Other bindings remain visible in the original full file.
  const expressions = new Set([
    '"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
    '"$(cd "$(dirname "$0")" && pwd)"',
  ]);
  for (const line of content.split('\n')) {
    const binding = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!binding || !expressions.has(binding[2])) continue;
    const name = binding[1];
    // A reassignment makes even this conservative lexical hint ambiguous.
    if ([...content.matchAll(new RegExp('\\b' + name + '(?:\\+)?=', 'g'))].length !== 1) continue;
    const reference = new RegExp(
      '"\\$(?:' + name + '|\\{' + name + '\\})/([A-Za-z0-9_./-]+)"',
      'g',
    );
    for (const match of content.matchAll(reference))
      addRelativeTarget(targets, path, match[1], all);
  }
  return targets;
}
