import React from 'react';
import { extractText } from './extractText';

/**
 * If children represent a mermaid code block (language-mermaid class on the
 * code element), returns the raw mermaid source. Otherwise returns null.
 */
export function getMermaidCode(children: React.ReactNode): string | null {
  const child = React.Children.toArray(children)[0];
  if (!React.isValidElement(child)) return null;
  const className = (child.props as Record<string, unknown>)?.className;
  if (typeof className === 'string' && /language-mermaid/.test(className)) {
    return extractText(children);
  }
  return null;
}
