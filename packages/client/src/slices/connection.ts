export type ConnectionStatus = 'connected' | 'disconnected' | 'reconnecting';

export interface ConnectionState {
  status: ConnectionStatus;
  clientId: string | null;
}

export const INITIAL_CONNECTION_STATE: ConnectionState = {
  status: 'disconnected',
  clientId: null,
};
