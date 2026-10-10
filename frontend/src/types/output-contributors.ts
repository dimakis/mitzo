import type {
  AgentProfileSelection,
  FinishedMessage,
  SessionOutputCandidate,
  SessionOutputReference,
} from '@mitzo/protocol';
import type { AccountSelection } from './account-selection';

export interface OutputContributor {
  id: string;
  label: string;
  accountLabel: string;
  model: string;
  sessionId: string | null;
  status: 'idle' | 'running' | 'unavailable' | 'stopping';
  outputId: string;
  outputRevision: number;
  messages?: FinishedMessage[];
}
export interface AddOutputContributor extends AccountSelection {
  accountId: string;
  label: string;
  instructions: string;
  mode: 'ask' | 'agent' | 'auto';
  profileSelection?: AgentProfileSelection;
  outputId: string;
  outputRevision: number;
  contextPackageDigest: string;
}
export interface OutputContributorPanelProps {
  sessionId: string;
  candidates: SessionOutputCandidate[];
  outputs: SessionOutputReference[];
  selected: {
    output: SessionOutputReference;
    content: string | null;
    contextPackageDigest: string | null;
  } | null;
  contributors: OutputContributor[];
  eligibility: { available: boolean | null; reason: string; accountIds?: string[] };
  loading?: boolean;
  error?: string;
  onRegister(candidate: SessionOutputCandidate, title: string): Promise<void>;
  onSelect(outputId: string): void;
  onAdd(input: AddOutputContributor): Promise<void>;
  onSend(contributorId: string, text: string): Promise<void>;
  onStop(contributorId: string): Promise<void>;
  onRefresh(): void;
}
