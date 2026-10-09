// Service health indicator — shows Yapper and ContexGin status on the home page.

import { useServiceHealth } from '../hooks/useServiceHealth';
import type { ServiceHealthStatus } from '@mitzo/protocol';

function ServiceDot({ service }: { service: ServiceHealthStatus | null }) {
  if (!service) return null;
  const color = service.ok ? 'var(--color-success)' : 'var(--color-danger)';
  return (
    <span className="service-dot" style={{ color }}>
      <span className="service-dot-indicator" style={{ background: color }} />
      {service.name}
    </span>
  );
}

export function ServiceStatus() {
  const { yapper, contexgin, checkedAt } = useServiceHealth();

  // Don't render until first health check arrives, or if no services are present
  if (checkedAt === 0 || (!yapper && !contexgin)) return null;

  return (
    <div className="service-status">
      <ServiceDot service={yapper} />
      <ServiceDot service={contexgin} />
    </div>
  );
}
