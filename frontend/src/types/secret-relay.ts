export type RelayOutcome = {
  outcome: 'not_sent' | 'confirmed' | 'unconfirmed' | 'challenge_required';
  status?: number;
  acknowledgement?: 'connack' | 'puback';
  challenge?: 'awaiting_code' | 'code_ready';
};
type Verification = { path: string; pointer: string; equals: string | number | boolean };
export type SecretRelayTarget = (
  | {
      adapter?: never;
      connectionId?: string;
      revision?: number;
      lanEndpoint?: string;
      path: string;
      method: 'POST' | 'PUT' | 'PATCH';
      encoding: 'json' | 'form';
      body: string;
      fields: string[];
    }
  | {
      adapter: 'mqtt';
      broker: string;
      username: string;
      allowPrivateNetwork: boolean;
      operation: 'connect' | 'publish';
      topic?: string;
      payload?: string;
      retain?: boolean;
    }
  | {
      adapter: 'browser';
      origin: string;
      allowPrivateNetwork: boolean;
      requests: Array<{ path: string; methods: string[] }>;
      login: {
        path: string;
        usernameSelector?: string;
        username?: string;
        passwordSelector: string;
        submitSelector: string;
      };
      mfa?: { codeSelector: string; submitSelector: string };
      verification: Verification;
      actions: Array<{
        label: string;
        path: string;
        fields: Array<{ selector: string; value: string }>;
        submitSelector: string;
        verification?: Verification;
      }>;
    }
) & { endpoint: string; label: string };
export interface SecretRelay {
  id: string;
  sessionId: string;
  revision: number;
  label: string;
  expiresAt: number;
  status: 'pending' | 'verifying' | 'ready' | 'cancelled' | 'expired' | 'unconfirmed';
  setupUrl: string;
  delivery?: 'pending' | 'delivered';
  continuation?: number;
  error?: string;
  targets: SecretRelayTarget[];
  outcomes: RelayOutcome[];
  actionOutcomes?: Record<string, RelayOutcome>;
}
