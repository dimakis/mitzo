import ReactMarkdown from 'react-markdown';
import { z } from 'zod';
const Grounding = z.object({
  provider: z.literal('google-vertex'),
  answer: z.string().max(64000),
  searchSuggestions: z.string().min(1).max(64000),
});

/** Keep provider grounding and its unchanged suggestion chip visible together. */
export function GoogleSearchResult({ result }: { result?: string }) {
  if (!result) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(result);
  } catch {
    return null;
  }
  const parsed = Grounding.safeParse(raw);
  if (!parsed.success) return null;
  const { answer, searchSuggestions } = parsed.data;
  const document = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https://www.gstatic.com https://www.google.com data:; base-uri 'none'; form-action 'none'"></head><body>${searchSuggestions}</body></html>`;
  return (
    <section aria-label="Google Search result" className="tool-pill-section">
      <ReactMarkdown
        components={{
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {answer}
      </ReactMarkdown>
      <iframe
        title="Google Search suggestions"
        srcDoc={document}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        style={{ width: '100%', height: 140, border: 0 }}
      />
    </section>
  );
}
