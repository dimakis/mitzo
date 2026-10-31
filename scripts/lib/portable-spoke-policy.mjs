import { Buffer } from 'node:buffer';
/** Declarative data from one accepted source revision; never execution settings. */
const hasControl = (value) =>
  [...value].some((part) => part.charCodeAt(0) < 32 || part.charCodeAt(0) === 127);
const safeRoot = (root) =>
  Buffer.from(root).toString('utf8') === root &&
  !root.includes('\\') &&
  !hasControl(root) &&
  root.split('/').every((part) => part && !part.startsWith('.'));
const contains = (root, path) => path === root || path.startsWith(root + '/');
const forbiddenSegment = (part) =>
  part.startsWith('.') || part.toLowerCase() === 'node_modules' || /^private(?:$|[_-])/i.test(part);
const roots = (value) => {
  if (
    !Array.isArray(value) ||
    value.length > 512 ||
    value.some((item) => typeof item !== 'string' || item.length > 200 || !safeRoot(item)) ||
    new Set(value).size !== value.length
  )
    throw Error('Invalid portable spoke policy roots');
  return [...value];
};
export function parsePortableSpokePolicy(value, requiredPrivateRoots = []) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.version !== 1 ||
    ![
      'portableRoots,privateRoots,version',
      'markdownRoots,portableRoots,privateRoots,version',
    ].includes(Object.keys(value).sort().join(','))
  )
    throw Error('Unsupported portable spoke policy');
  const portableRoots = roots(value.portableRoots),
    privateRoots = roots(value.privateRoots);
  const markdownRoots = Object.hasOwn(value, 'markdownRoots') ? roots(value.markdownRoots) : [];
  const required = roots(requiredPrivateRoots);
  if (
    required.some((root) => !privateRoots.includes(root)) ||
    [...portableRoots, ...markdownRoots].some(
      (root) =>
        root.split('/').some(forbiddenSegment) ||
        privateRoots.some(
          (privateRoot) =>
            contains(privateRoot.toLowerCase(), root.toLowerCase()) ||
            contains(root.toLowerCase(), privateRoot.toLowerCase()),
        ),
    )
  )
    throw Error('Portable spoke policy crosses a private boundary');
  return { version: 1, portableRoots, markdownRoots, privateRoots };
}
export function portableSpokePaths(policy) {
  return [
    ...policy.portableRoots.flatMap((root) => [
      root + '/CONSTITUTION.md',
      root + '/AGENTS.md',
      root + '/CLAUDE.md',
      root + '/context/',
    ]),
    ...policy.markdownRoots.map((root) => root + '/'),
  ];
}
export function portableSpokePathPermitted(policy, path) {
  if (
    typeof path !== 'string' ||
    !path.endsWith('.md') ||
    path.includes('\\') ||
    hasControl(path) ||
    path.split('/').some((part) => !part || forbiddenSegment(part)) ||
    policy.privateRoots.some((root) => contains(root.toLowerCase(), path.toLowerCase()))
  )
    return false;
  return true;
}
export function portableSpokePathSelected(policy, path) {
  if (!portableSpokePathPermitted(policy, path)) return false;
  return (
    policy.markdownRoots.some((root) => path.startsWith(root + '/')) ||
    policy.portableRoots.some((root) => {
      if (!path.startsWith(root + '/')) return false;
      const relative = path.slice(root.length + 1);
      return (
        ['CONSTITUTION.md', 'AGENTS.md', 'CLAUDE.md'].includes(relative) ||
        relative.startsWith('context/')
      );
    })
  );
}

export function parsePortableSpokePolicyText(content, requiredPrivateRoots = []) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > 128 * 1024)
    throw Error('Portable spoke policy exceeds its data limit');
  let value;
  try {
    value = JSON.parse(content);
  } catch {
    throw Error('Portable spoke policy is not valid JSON data');
  }
  return parsePortableSpokePolicy(value, requiredPrivateRoots);
}
