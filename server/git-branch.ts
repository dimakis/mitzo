/** Literal Git branch syntax (check-ref-format --branch), without process effects.
 * Revision expressions and previous-checkout expansion are deliberately excluded.
 */
export function isGitBranchName(value: string): boolean {
  if (
    !value ||
    value === 'HEAD' ||
    value.startsWith('-') ||
    value.endsWith('.') ||
    value.includes('..') ||
    value.includes('@{')
  )
    return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f || '~^:?*[\\'.includes(character)) return false;
  }
  return value
    .split('/')
    .every(
      (component) => !!component && !component.startsWith('.') && !component.endsWith('.lock'),
    );
}
