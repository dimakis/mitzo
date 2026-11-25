/**
 * Rewrite the fingerprint values of already registered entries in the reviewed
 * handler manifest source. Registration (which keys exist) stays a reviewed,
 * manual decision: unknown, missing or duplicated keys fail instead of guessing.
 */
const block = /export const reviewedHandlerSourceArtifacts = Object\.freeze\(\{([\s\S]*?)\n\}\);/;
const entry = /'([^'\r\n]+)':(\s*)'([^'\r\n]*)'/g;

export function rewriteReviewedHandlerArtifacts(source, fingerprints) {
  const match = block.exec(source);
  if (!match) throw Error('Reviewed handler manifest block not found');
  const start = match.index + match[0].indexOf('{') + 1;
  const body = match[1];
  const seen = new Set();
  const updated = [];
  const rewritten = body.replace(entry, (text, name, space, value) => {
    if (seen.has(name)) throw Error(`Duplicate reviewed handler entry: ${name}`);
    seen.add(name);
    const fingerprint = fingerprints[name];
    if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint))
      throw Error(`No current fingerprint for registered entry: ${name}`);
    if (value === fingerprint) return text;
    updated.push(name);
    return `'${name}':${space}'${fingerprint}'`;
  });
  const missing = Object.keys(fingerprints).filter((name) => !seen.has(name));
  if (missing.length) throw Error(`Registered entries not rewritten: ${missing.join(', ')}`);
  return {
    source: source.slice(0, start) + rewritten + source.slice(start + body.length),
    updated,
  };
}
