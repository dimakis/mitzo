export interface ObservabilityServiceResult {
  ok: boolean;
  durationMs: number;
  code?: string;
  stage?: string;
  causeName?: string;
  causeCode?: string;
  recentRecords?: number;
  newestAgeSeconds?: number | null;
  experiments?: number;
  runs?: number;
  diagnosticRuns?: number;
  applicationRuns?: number;
  datasources?: number;
  proxyRecentRecords?: Record<string, number>;
  traceViewer?: 'verified' | 'unverified-no-traces';
  role?: string;
  artifactReadback?: 'verified' | 'unverified-no-diagnostic';
}
export interface ObservabilityOptions {
  fetchImpl?: (url: URL, init: RequestInit) => Promise<Response>;
  now?: number;
  requireRecent?: boolean;
  tracesOnly?: boolean;
  endpoints?: Record<'loki' | 'jaeger' | 'grafana' | 'mlflow', string>;
}
export function verifyObservability(options?: ObservabilityOptions): Promise<{
  ok: boolean;
  checkedAt: string;
  services: Record<string, ObservabilityServiceResult>;
}>;
