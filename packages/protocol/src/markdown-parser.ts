import { unified } from 'unified';
import remarkParse from 'remark-parse';

/** Shared syntax parser; document-specific transforms belong at the call site. */
export const markdownParser = unified().use(remarkParse).freeze();
