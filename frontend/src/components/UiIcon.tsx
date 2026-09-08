const paths = {
  today: 'M3 10 12 3l9 7v11h-6v-7H9v7H3Z',
  chats: 'M4 4h16v12H9l-5 4Z',
  proposals: 'M4 4h16v16H4ZM4 14h5l2 3h2l2-3h5',
  work: 'm4 6 2 2 4-4m3 2h7M4 14l2 2 4-4m3 2h7m-7 6h7',
  agents: 'M8 4h8v6H8ZM4 16h6v5H4Zm10 0h6v5h-6ZM12 10v3M7 16v-3h10v3',
  calendar: 'M5 5h14v16H5ZM8 3v4m8-4v4M5 11h14',
  files: 'M3 6h7l2 3h9v11H3Z',
  more: 'M5 11h1v2H5Zm6 0h1v2h-1Zm6 0h1v2h-1Z',
  panel: 'M3 4h18v16H3ZM9 4v16',
  up: 'm6 15 6-6 6 6',
  down: 'm6 9 6 6 6-6',
  send: 'M12 20V4m-7 7 7-7 7 7',
  stop: 'M7 7h10v10H7Z',
  mic: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0ZM5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8',
  blocked: 'M9 5a3 3 0 0 1 6 0v7M5 10v2a7 7 0 0 0 12 5M12 19v3M3 3l18 18',
  loading: 'M20 12a8 8 0 1 1-8-8',
  settings: 'M4 7h16M4 17h16M8 4v6m8 4v6',
  interrupt: 'm13 2-8 12h7l-1 8 8-12h-7Z',
} as const;
export function UiIcon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  );
}
