import { initTheme } from './hooks/useTheme';
import 'highlight.js/styles/github-dark-dimmed.min.css';
import './styles/tokens.css';
import './styles/global.css';
import './styles/code-block.css';
import './styles/calendar.css';
import './styles/desktop.css';
import './styles/workspace.css';
// Home controls/dialogs are shared by independently loaded routes.
import './styles/home.css';
import './styles/connections-setup.css';
import './styles/connection-setup-card.css';
import './styles/workspace-chat.css';
import './styles/workspace-work.css';
import './styles/workspace-agents.css';
import './styles/workspace-collections.css';
import './pages/KnowledgeLibrary.css';
import './styles/mobile-workspace.css';
import './styles/appearance.css';
import './pages/TerminalView.css';
import './styles/motion.css';

import { initializeChatStorage } from './lib/large-chat-storage';

initTheme();

// Missing payloads retain the existing fail-closed draft/outbox recovery behavior.
void initializeChatStorage()
  .catch(() => {})
  .then(() => import('./render-app'));
