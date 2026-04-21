import { useNavigate } from 'react-router-dom';

export function BriefingCard() {
  const navigate = useNavigate();

  function handleStartSession() {
    const params = new URLSearchParams();
    params.set(
      'prompt',
      'Run my morning briefing — calendar, email highlights, Jira status, and Slack signals.',
    );
    navigate(`/chat?${params.toString()}`);
  }

  return (
    <button className="briefing-btn" onClick={handleStartSession}>
      <span className="briefing-btn-icon">☀</span>
      <span className="briefing-btn-text">
        <span className="briefing-btn-title">Morning Briefing</span>
        <span className="briefing-btn-desc">Calendar, email, Jira, Slack</span>
      </span>
      <span className="briefing-btn-arrow">›</span>
    </button>
  );
}
