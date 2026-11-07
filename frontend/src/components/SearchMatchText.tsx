import { sessionSearchTerms } from '@mitzo/protocol';
import './SearchMatchText.css';

/** React text nodes keep snippets inert, including HTML and regex punctuation. */
export function SearchMatchText({ text, query }: { text: string; query: string }) {
  let terms: string[];
  try {
    terms = sessionSearchTerms(query);
  } catch {
    return <>{text}</>;
  }
  if (!terms.length) return <>{text}</>;
  const pattern = new RegExp(
    terms
      .sort((a, b) => b.length - a.length)
      .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|'),
    'giu',
  );
  const nodes = [];
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index!;
    nodes.push(
      text.slice(end, start),
      <mark className="search-match" key={start}>
        {match[0]}
      </mark>,
    );
    end = start + match[0].length;
  }
  return (
    <>
      {nodes}
      {text.slice(end)}
    </>
  );
}
