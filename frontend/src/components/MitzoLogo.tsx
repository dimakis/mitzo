import { useNavigate } from 'react-router-dom';

export function MitzoLogo() {
  const navigate = useNavigate();

  return (
    <button className="mitzo-logo" onClick={() => navigate('/')} aria-label="Home">
      M
    </button>
  );
}
