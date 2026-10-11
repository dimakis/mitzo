import type {
  SeatConfig,
  SymposiumConfig,
  SymposiumDeliveryRecord,
  SymposiumMembershipRecord,
  SymposiumAdmissionRecord,
} from '@mitzo/protocol';

import type { SymposiumProfileSelection } from './symposium-profile';

export interface DirectorSeat {
  seatId: string;
  seat: SeatConfig;
  membership: SymposiumMembershipRecord | null;
  admitted: boolean;
  admissionRecorded?: boolean;
  savedRuntimeState?: string | null;
  creationDiagnostic?: {
    phase: string;
    code: string;
    canCleanup: boolean;
    recoveryIdempotencyKey?: string;
    recoveryAuthorization?: {
      operationId: string;
      revision: number;
      state: 'reauthorization_required' | 'cleanup_fenced' | 'authorized';
    };
  } | null;
  admission?: Pick<
    SymposiumAdmissionRecord,
    'configRevision' | 'membershipGeneration' | 'decision'
  > | null;
}
export interface DirectorStatus {
  sessionId: string;
  config: SymposiumConfig | null;
  seats: DirectorSeat[];
  runtimeAvailable: boolean;
  statusMode?: string;
  runtimeVerification?: string;
  profileBindingEnforced?: boolean;
  initialProfileSelections?: Record<string, SymposiumProfileSelection>;
  reservedSeats: number;
  capacityRemaining: number;
  deliveries: SymposiumDeliveryRecord[];
}
