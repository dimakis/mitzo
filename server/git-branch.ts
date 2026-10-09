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
    value.includes('@{') ||
    /[\x00-\x20\x7f~^:?*\[\\]/.test(value)
  )
    return false;
  return value
    .split('/')
    .every(
      (component) => !!component && !component.startsWith('.') && !component.endsWith('.lock'),
    );
}
