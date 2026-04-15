export interface InboxItem {
  filename: string;
  agent: string;
  title: string;
  tags: string[];
  timestamp: string;
  preview: string;
}

export interface InboxState {
  items: InboxItem[];
  count: number;
}

export const INITIAL_INBOX_STATE: InboxState = {
  items: [],
  count: 0,
};
