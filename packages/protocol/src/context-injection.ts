/** Display metadata for references already assembled into a user prompt. */
export interface ContextInjection {
  name: string;
  source: string;
  content: string;
}

const preamble =
  'The user has attached the following reference files for this message.\n' +
  'Use them to inform your response.\n\n';
const separator = '\n\n---CONTEXT_END---\n';
const decodeAttribute = (value: string) =>
  value.replace(
    /&(?:amp|lt|gt|quot|apos|#39);/g,
    (entity) =>
      ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" })[
        entity
      ]!,
  );

/**
 * Recognize only the complete application envelope, never an arbitrary marker
 * in user text. This is a display projection, not source authorization.
 */
export function splitContextPrompt(
  prompt: string,
): { text: string; injections: ContextInjection[] } | null {
  if (!prompt.startsWith(preamble)) return null;
  const injections: ContextInjection[] = [];
  let offset = preamble.length;
  while (offset < prompt.length) {
    const header = /^<context name="([^"]*)" source="([^"]*)">\n/.exec(prompt.slice(offset));
    if (!header) return null;
    const start = offset + header[0].length;
    // A literal closing tag inside a source is not a boundary unless followed
    // by another envelope reference or the actual application separator.
    const end = /\n<\/context>(?=\n\n(?:<context name=|---CONTEXT_END---\n))/g;
    end.lastIndex = start;
    const closing = end.exec(prompt);
    if (!closing) return null;
    injections.push({
      name: decodeAttribute(header[1]),
      source: decodeAttribute(header[2]),
      content: prompt.slice(start, closing.index),
    });
    offset = closing.index + closing[0].length;
    if (prompt.startsWith(separator, offset))
      return { text: prompt.slice(offset + separator.length), injections };
    offset += 2; // Serialized references are separated by two newlines.
  }
  return null;
}
