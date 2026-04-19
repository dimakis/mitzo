import { useNavigate } from 'react-router-dom';

const SECTIONS = [
  { key: 'calendar', label: 'Calendar', summary: null as string | null },
  { key: 'email', label: 'Email', summary: null as string | null },
  { key: 'jira', label: 'Jira', summary: null as string | null },
  { key: 'slack', label: 'Slack', summary: null as string | null },
];

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
    <div className="briefing-card">
      <div className="briefing-card-header">
        <div>
          <h2 className="briefing-card-title">Morning Briefing</h2>
          <span className="briefing-card-time">Not yet run</span>
        </div>
      </div>

      <div className="briefing-card-sections">
        {SECTIONS.map((s) => (
          <div key={s.key} className="briefing-card-section">
            <span className="briefing-card-section-label">{s.label}</span>
            <span className="briefing-card-section-summary">{s.summary ?? 'No data'}</span>
          </div>
        ))}
      </div>

      <div className="briefing-card-actions">
        <button className="briefing-card-btn briefing-card-btn--start" onClick={handleStartSession}>
          Start Session
        </button>
      </div>
    </div>
  );
}
