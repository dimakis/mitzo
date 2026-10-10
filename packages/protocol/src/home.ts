/** Workspace preferences are shared by devices, independently of provider accounts. */
export interface HomePin {
  kind: 'session' | 'telos';
  id: string;
  title: string;
}
export interface HomePreferences {
  revision: number;
  names: { briefing: string; terminal: string };
  pins: HomePin[];
  showDailyQuote: boolean;
}
export interface PhilosophyQuote {
  id: string;
  text: string;
  author: string;
  work: string;
  translation: string;
  explanation: string;
  example: string;
  biography: string;
  sourceUrl: string;
  explainerUrl: string;
  authorUrl: string;
}
export interface DailyQuote {
  date: string;
  quote: PhilosophyQuote;
}
export interface BriefingSnapshot {
  filename: string;
  path: string;
  date: string;
  generatedAt: string;
  revision: string;
  content: string;
}
export interface BriefingChatBinding {
  date: string;
  revision: string;
  sessionId: string;
  accountId: string;
  model: string;
  createdAt: string;
}
