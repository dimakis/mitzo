export type BackupRunStatus =
  'capturing' | 'encrypting' | 'publishing' | 'pending' | 'uploaded' | 'failed' | 'interrupted';
export interface BackupRun {
  id: string;
  startedAt: string;
  completedAt?: string;
  status: BackupRunStatus;
  snapshot?: string;
  generation?: string;
  bytes?: number;
  cloudVerifiedAt?: string;
  error?:
    | 'Backup did not complete. Check host configuration and retry.'
    | 'Upload verification unavailable. Retry verification.';
}
export interface BackupOverview {
  ready: boolean;
  busy: boolean;
  setup: string[];
  runs: BackupRun[];
  lastCapture: string | null;
  lastCloudUpload: string | null;
  coverage: Array<{ name: string; supported: boolean; detail: string }>;
}
