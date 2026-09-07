import { NavLink } from 'react-router-dom';

const primary = [
  { label: 'Today', path: '/', end: true },
  { label: 'Chats', path: '/sessions', end: false },
  { label: 'Proposals', path: '/inbox', end: false },
  { label: 'Work', path: '/todos', end: false },
];
const secondary = [
  { label: 'Agents', path: '/tasks', end: false },
  { label: 'Calendar', path: '/calendar', end: false },
  { label: 'Files', path: '/files', end: false },
];
export function WorkspaceNav({ desktop = false }: { desktop?: boolean }) {
  const items = [
    ...primary,
    ...(desktop ? secondary : []),
    { label: 'More', path: '/more', end: false },
  ];
  return (
    <nav
      className={desktop ? 'workspace-nav' : 'tab-bar workspace-tabs'}
      aria-label="Main navigation"
    >
      {items.map(({ label, path, end }) => (
        <NavLink
          key={path}
          to={path}
          end={end}
          className={({ isActive }) =>
            `workspace-nav-link${isActive ? ' workspace-nav-link--active' : ''}`
          }
        >
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
