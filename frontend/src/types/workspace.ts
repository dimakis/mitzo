export interface WorkspaceSummary {
  sessionType?: 'chat' | 'symposium';
  profile: string;
  location?: 'local' | 'openshell';
  model?: string;
  thinking?: string;
}
