import { Link, useParams } from 'react-router-dom';
import { useDailyQuote } from '../hooks/useDailyQuote';
import { WorkspacePageHeading } from '../components/WorkspacePageHeading';
import '../styles/home.css';
function SafeSourceLink({ href, children }: { href: string; children: string }) {
  if (typeof href !== 'string' || !/^https:\/\//.test(href)) return <span>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children} <span aria-hidden="true">↗</span>
    </a>
  );
}
export function QuoteView() {
  const { date = '' } = useParams();
  const { quote, loading, error, retry } = useDailyQuote(date);
  const item = quote?.quote;
  return (
    <main className="workspace-page quote-page">
      <Link className="workspace-text-link" to="/">
        ← Today
      </Link>
      <WorkspacePageHeading eyebrow={date} title="A thought for today" />
      {loading ? (
        <p role="status">Loading quote…</p>
      ) : error ? (
        <div role="alert">
          <p>{error}</p>
          <button className="home-secondary" onClick={retry}>
            Try again
          </button>
        </div>
      ) : (
        item && (
          <article>
            <blockquote>
              <p>{item.text}</p>
              <footer>
                {item.author} · <cite>{item.work}</cite>
              </footer>
            </blockquote>
            <p className="workspace-muted">{item.translation}</p>
            <section>
              <h2>A way to read it</h2>
              <p>{item.explanation}</p>
              <p className="workspace-muted">
                An interpretation, rather than the author’s own words.
              </p>
              <SafeSourceLink href={item.explainerUrl}>Explore the idea</SafeSourceLink>
            </section>
            <section>
              <h2>In everyday life</h2>
              <p>{item.example}</p>
            </section>
            <section>
              <h2>About {item.author}</h2>
              <p>{item.biography}</p>
              <SafeSourceLink href={item.authorUrl}>Learn about the author</SafeSourceLink>
            </section>
            <section>
              <h2>The source</h2>
              <p className="workspace-muted">
                {item.work} · {item.translation}
              </p>
              <SafeSourceLink href={item.sourceUrl}>Read the source</SafeSourceLink>
            </section>
          </article>
        )
      )}
    </main>
  );
}
