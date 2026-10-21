export interface SecretRelay {
  id: string;
  sessionId: string;
  revision: number;
  label: string;
  expiresAt: number;
  status: 'pending' | 'verifying' | 'ready' | 'cancelled' | 'expired' | 'unconfirmed';
  setupUrl: string;
  delivery?: 'pending' | 'delivered';
  error?: string;
  targets: Array<{
    connectionId?: string;
    revision?: number;
    lanEndpoint?: string;
    endpoint: string;
    label: string;
    path: string;
    method: 'POST' | 'PUT' | 'PATCH';
    encoding: 'json' | 'form';
    body: string;
    fields: string[];
  }>;
  outcomes: Array<{ outcome: 'not_sent' | 'confirmed' | 'unconfirmed'; status?: number }>;
}
