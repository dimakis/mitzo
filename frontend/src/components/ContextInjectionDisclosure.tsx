import { useId, useState, type ReactNode } from 'react';
import type { ContextInjection } from '@mitzo/protocol';
import { MotionPresence } from './MotionPresence';
import { UiIcon } from './UiIcon';
import { CopyButton } from './CopyButton';

export function ContextInjectionDisclosure({
  names,
  injections,
  label,
  renderContent,
}: {
  label?: string;
  renderContent?: (item: ContextInjection) => ReactNode;
  names: string[];
  injections?: ContextInjection[];
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!names.length && !injections?.length) return null;
  const actualNames = injections?.map((item) => item.name) ?? names;
  return (
    <div className="msg-context-injection">
      <button
        type="button"
        className="msg-context-injection-toggle"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <UiIcon name="layers" size={16} />
        <span className="msg-context-injection-label">
          <span>{label ?? (injections?.length ? 'Context injected' : 'Context selected')}</span>
          <span className="msg-context-injection-names">{actualNames.join(', ')}</span>
        </span>
        <UiIcon name={open ? 'up' : 'down'} size={16} />
      </button>
      <MotionPresence open={open} kind="disclosure" appear={false} id={id}>
        <div className="msg-context-injection-body">
          {injections?.length ? (
            injections.map((item, index) => (
              <section key={`${index}:${item.source}`} className="msg-context-injection-source">
                <div className="msg-context-injection-heading">
                  <strong>{item.name}</strong>
                  <CopyButton text={item.content} label={`Copy injected ${item.name} context`} />
                </div>
                <div className="msg-context-injection-path">{item.source}</div>
                {renderContent ? (
                  renderContent(item)
                ) : (
                  <pre tabIndex={0} aria-label={`${item.name} injected content`}>
                    {item.content}
                  </pre>
                )}
              </section>
            ))
          ) : (
            <p>Context content will appear here when it is recorded with this message.</p>
          )}
        </div>
      </MotionPresence>
    </div>
  );
}
