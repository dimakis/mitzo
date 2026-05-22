import { Children, isValidElement, type ReactNode } from 'react';

/** Recursively extract plain text from a React node tree. */
export function extractText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (isValidElement(node)) return extractText(node.props.children);
  if (Array.isArray(node)) return Children.toArray(node).map(extractText).join('');
  return '';
}
