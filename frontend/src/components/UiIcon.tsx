const paths = {
  forward: 'm9 6 6 6-6 6',
  left: 'M20 12H4m6-6-6 6 6 6',
  right: 'M4 12h16m-6-6 6 6-6 6',
  arrowDown: 'M12 4v16m-6-6 6 6 6-6',
  external: 'M15 3h6v6m0-6-10 10M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4',
  close: 'm6 6 12 12M6 18 18 6',
  share: 'M12 16V3m-5 5 5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6',
  download: 'M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5',
  upload: 'M12 16V4m-5 5 5-5 5 5M5 16v5h14v-5',
  volume: 'M11 5 6 9H3v6h3l5 4ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14',
  file: 'M14 3H5v18h14V8Zm0 0v5h5M8 13h8M8 17h5',
  image: 'M3 3h18v18H3ZM3 16l5-5 4 4 4-4 5 5M8 7h.01',
  layers: 'm12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5',
  terminal: 'M3 4h18v16H3Zm4 4 4 4-4 4m6 0h4',
  user: 'M8 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0M4 21v-2a8 8 0 0 1 16 0v2',
  circle: 'M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20',
  running: 'M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20M12 10a2 2 0 1 0 0 4a2 2 0 1 0 0-4',
  complete: 'M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20m-5 10 3 3 6-6',
  review: 'M9 3H5v18h14V3h-4M9 2h6v4H9Zm-1 12 3 3 5-6',
  unavailable: 'M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20M5 5l14 14',
  failed: 'M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20m-4 6 8 8m-8 0 8-8',
  error: 'M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20m0 5v6m0 4h.01',
  warning: 'M12 3 2 21h20ZM12 9v5m0 3h.01',
  clock: 'M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20m0 5v5l3 2',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm10-3a3 3 0 1 0 0 6a3 3 0 1 0 0-6',
  star: 'm12 3 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1Z',
  pause: 'M6 4h4v16H6Zm8 0h4v16h-4Z',
  play: 'm6 3 15 9-15 9Z',
  minus: 'M5 12h14',
  plus: 'M12 5v14M5 12h14',
  retry: 'M20 7v5h-5m5-5a9 9 0 1 0 1 9',
  filter: 'M4 5h16M7 12h10m-7 7h4',
  panelLeft: 'M3 4h18v16H3ZM9 4v16m4-12 3 4-3 4',
  panelRight: 'M3 4h18v16H3ZM15 4v16m-4-12-3 4 3 4',
  panelLeftClose: 'M3 4h18v16H3ZM9 4v16m7-12-3 4 3 4',
  panelRightClose: 'M3 4h18v16H3ZM15 4v16m-7-12 3 4-3 4',
  sun: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1',
  search: 'M10 3a7 7 0 1 0 0 14a7 7 0 0 0 0-14Zm5 12 6 6',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
  shield: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Zm-4 9 3 3 5-6',
  check: 'm5 12 4 4L19 6',
  back: 'm14 6-6 6 6 6',
  today: 'M3 10 12 3l9 7v11h-6v-7H9v7H3Z',
  chats: 'M4 4h16v12H9l-5 4Z',
  proposals: 'M4 4h16v16H4ZM4 14h5l2 3h2l2-3h5',
  work: 'm4 6 2 2 4-4m3 2h7M4 14l2 2 4-4m3 2h7m-7 6h7',
  agents: 'M8 4h8v6H8ZM4 16h6v5H4Zm10 0h6v5h-6ZM12 10v3M7 16v-3h10v3',
  calendar: 'M5 5h14v16H5ZM8 3v4m8-4v4M5 11h14',
  files: 'M3 6h7l2 3h9v11H3Z',
  worktree:
    'M6 3v12m0-7h7a5 5 0 0 0 5-5M3 18a3 3 0 1 0 6 0a3 3 0 1 0-6 0M15 3a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
  connections:
    'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',
  edit: 'm16 3 5 5-12 12-6 1 1-6ZM14 5l5 5',
  copy: 'M9 9h12v12H9ZM15 9V3H3v12h6',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
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
export type UiIconName = keyof typeof paths;

export function UiIcon({
  name,
  size = 20,
  filled = false,
}: {
  name: UiIconName;
  size?: 16 | 20 | 24;
  filled?: boolean;
}) {
  return (
    <svg
      className="ui-icon"
      data-icon={name}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
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
