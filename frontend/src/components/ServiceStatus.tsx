// Service health indicator — shows Yapper and ContexGin status on the home page.

import { useServiceHealth } from '../hooks/useServiceHealth';
import type { ServiceHealthStatus } from '@mitzo/protocol';

function ServiceDot({ service }: { service: ServiceHealthStatus | null }) {
  if (!service) return null;
  const color = service.ok ? '#4ade80' : '#ff6d6d';
  return (
    <span className="service-dot" style={{ color }}>
      <span className="service-dot-indicator" style={{ background: color }} />
      {service.name}
    </span>
  );
}

export function ServiceStatus() {
  const { yapper, contexgin, checkedAt } = useServiceHealth();

  // Don't render until first health check arrives
  if (checkedAt === 0) return null;

  return (
    <div className="service-status">
      <ServiceDot service={yapper} />
      <ServiceDot service={contexgin} />
    </div>
  );
}
