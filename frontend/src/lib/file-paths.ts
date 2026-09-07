/** Internal scheme for file path links — intercepted by the custom renderer. */
export const FILE_SCHEME = 'file-path://';

/**
 * Decode an internal file URL without allowing malformed URI data to escape
 * into the React render path.
 */
export function decodeFilePathUrl(url: string): string | null {
  if (!url.startsWith(FILE_SCHEME)) return null;

  try {
    return decodeURIComponent(url.slice(FILE_SCHEME.length));
  } catch {
    return null;
  }
}

interface MarkdownNode {
  type: string;
  url?: string;
  identifier?: string;
  children?: MarkdownNode[];
}

/**
 * Remark plugin that turns malformed internal file links into readable text.
 * It runs before Markdown URL normalization and only visits parsed link nodes,
 * so every supported link form is covered while code remains byte-for-byte.
 */
export function remarkNeutralizeMalformedFileLinks() {
  return (tree: MarkdownNode) => {
    const definitions = new Map<string, boolean>();

    const collectDefinitions = (node: MarkdownNode) => {
      if (node.type === 'definition' && node.identifier && !definitions.has(node.identifier)) {
        definitions.set(
          node.identifier,
          Boolean(node.url?.startsWith(FILE_SCHEME) && decodeFilePathUrl(node.url) === null),
        );
      }
      node.children?.forEach(collectDefinitions);
    };

    const visit = (node: MarkdownNode) => {
      if (!node.children) return;

      node.children = node.children.flatMap((child) => {
        const malformedDirectLink =
          child.type === 'link' &&
          child.url?.startsWith(FILE_SCHEME) &&
          decodeFilePathUrl(child.url) === null;
        const malformedReference =
          child.type === 'linkReference' &&
          child.identifier !== undefined &&
          definitions.get(child.identifier) === true;

        if (malformedDirectLink || malformedReference) {
          return child.children ?? [];
        }

        visit(child);
        return [child];
      });
    };

    collectDefinitions(tree);
    visit(tree);
  };
}

/** Detect whether a string looks like a file path (not a URL). */
export function isFilePath(str: string): boolean {
  // Reject URLs
  if (/^https?:\/\//.test(str)) return false;

  // Must start with /, ./, or ../  OR contain a / with a file extension
  const isAbsolute = str.startsWith('/');
  const isRelative = str.startsWith('./') || str.startsWith('../');
  const hasDirSlash = str.includes('/');

  if (!isAbsolute && !isRelative && !hasDirSlash) return false;

  // Reject bare root
  if (str === '/') return false;

  // Must have either a file extension or multiple path segments
  const hasExtension = /\.\w+$/.test(str);
  const segments = str.split('/').filter(Boolean);
  const hasDepth = segments.length >= 2;

  return hasExtension || hasDepth;
}

export interface FilePathMatch {
  path: string;
  start: number;
  end: number;
}

/**
 * Find file paths in a block of text.
 * Matches absolute paths (/...) and relative paths (./... or ../...).
 * Skips URLs (http:// or https://).
 */
export function detectFilePaths(text: string): FilePathMatch[] {
  // Match paths: absolute (/...) or relative (./... or ../...)
  // Path chars: word chars, hyphens, dots, @, slashes — no spaces (too greedy)
  const pathPattern = /(?<!\w)(?:(?:\.\.?)?\/[\w./@-]+(?:\/[\w./@-]+)*)/g;

  const matches: FilePathMatch[] = [];

  for (const match of text.matchAll(pathPattern)) {
    const raw = match[0];
    const start = match.index;

    // Check that the character before isn't part of a URL scheme
    if (start > 0) {
      const before = text.slice(Math.max(0, start - 8), start);
      if (/https?:\/?\/?$/.test(before)) continue;
    }

    // Strip trailing punctuation that's likely sentence-end
    const cleaned = raw.replace(/[.,;:!?)]+$/, '');

    if (isFilePath(cleaned)) {
      matches.push({ path: cleaned, start, end: start + cleaned.length });
    }
  }

  return matches;
}

/**
 * Pre-process markdown content to wrap detected file paths in links.
 * Already-linked paths (inside []() or backtick fences) are skipped.
 */
export function linkifyFilePaths(content: string): string {
  // Process line by line to skip code blocks
  const lines = content.split('\n');
  let inCodeBlock = false;
  const result: string[] = [];

  for (const line of lines) {
    if (/^```/.test(line.trimStart())) {
      inCodeBlock = !inCodeBlock;
      result.push(line);
      continue;
    }
    if (inCodeBlock) {
      result.push(line);
      continue;
    }
    result.push(linkifyLine(line));
  }

  return result.join('\n');
}

function linkifyLine(line: string): string {
  const matches = detectFilePaths(line);
  if (matches.length === 0) return line;

  // Build exclusion ranges for inline backticks and existing markdown links
  const excludedRanges: Array<[number, number]> = [];

  const backtickPattern = /`[^`]+`/g;
  for (const bm of line.matchAll(backtickPattern)) {
    excludedRanges.push([bm.index, bm.index + bm[0].length]);
  }

  const linkPattern = /\[[^\]]*\]\([^)]*\)/g;
  for (const lm of line.matchAll(linkPattern)) {
    excludedRanges.push([lm.index, lm.index + lm[0].length]);
  }

  let out = '';
  let cursor = 0;

  for (const m of matches) {
    // Skip if inside backticks or existing markdown links
    const inBackticks = excludedRanges.some(([s, e]) => m.start >= s && m.end <= e);
    if (inBackticks) {
      continue;
    }

    out += line.slice(cursor, m.start);
    out += `[${m.path}](${FILE_SCHEME}${encodeURIComponent(m.path)})`;
    cursor = m.end;
  }

  out += line.slice(cursor);
  return out;
}
