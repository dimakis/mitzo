import type { Session } from '@mitzo/protocol';

export interface SessionsState {
  list: Session[];
  active: string | null;
  loading: boolean;
}

export const INITIAL_SESSIONS_STATE: SessionsState = {
  list: [],
  active: null,
  loading: false,
};
