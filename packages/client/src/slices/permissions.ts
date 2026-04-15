import type { PermissionRequest } from '@mitzo/protocol';

export interface PermissionsState {
  pending: PermissionRequest | null;
}

export const INITIAL_PERMISSIONS_STATE: PermissionsState = {
  pending: null,
};
