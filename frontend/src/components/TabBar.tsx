import type { Tab } from '../hooks/useDesktopTabs';

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  chatTabId: string;
}

export function TabBar({ tabs, activeTabId, onActivate, onClose, chatTabId }: TabBarProps) {
  if (tabs.length <= 1) return null;

  return (
    <div className="tab-bar">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`tab-bar-item${tab.id === activeTabId ? ' tab-bar-item--active' : ''}`}
          onClick={() => onActivate(tab.id)}
          title={tab.type === 'file' ? tab.filePath : tab.label}
          role="tab"
          aria-selected={tab.id === activeTabId}
        >
          <span className="tab-bar-icon">{tab.type === 'file' ? '\u2630' : '\u2726'}</span>
          <span className="tab-bar-label">{tab.label}</span>
          {tab.id !== chatTabId && (
            <button
              className="tab-bar-close"
              aria-label="Close tab"
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
            >
              &times;
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
