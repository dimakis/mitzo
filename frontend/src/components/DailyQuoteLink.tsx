import { Link } from 'react-router-dom';
import { useDailyQuote } from '../hooks/useDailyQuote';
import '../styles/home.css';
export function DailyQuoteLink({ date }: { date: string }) {
  const { quote } = useDailyQuote(date);
  if (!quote) return null;
  return (
    <Link
      className="home-daily-quote"
      to={`/quotes/${date}`}
      aria-label={`Quote of the day by ${quote.quote.author}`}
    >
      <span aria-hidden="true">“</span>
      <span>{quote.quote.author}</span>
    </Link>
  );
}
