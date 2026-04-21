import { useNavigate } from 'react-router-dom';

export function MitzoLogo() {
  const navigate = useNavigate();

  return (
    <button className="mitzo-logo" onClick={() => navigate('/')} aria-label="Home">
      <img src="/mitzo-icon.png" alt="Mitzo" width={28} height={28} />
    </button>
  );
}
