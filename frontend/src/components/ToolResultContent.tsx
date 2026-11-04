import { useId, useMemo, useState } from 'react';
import { CopyButton } from './CopyButton';
import { MotionPresence } from './MotionPresence';
import { UiIcon } from './UiIcon';
import '../styles/tool-result.css';

type Value = string | boolean | null | Value[] | { [key: string]: Value };
const PAGE_SIZE = 10;

function parseResult(text: string): Value[] | { [key: string]: Value } | null {
  const first = text.trimStart()[0];
  if (text.length > 256 * 1024 || (first !== '[' && first !== '{')) return null;
  try {
    JSON.parse(text); // Validate before preserving numeric source tokens as display strings.
    // JSON.parse rounds large IDs. Preserve all number spellings, ignoring quoted strings.
    return JSON.parse(
      text.replace(
        /"(?:[^"\\]|\\.)*"|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
        (token, number: string | undefined) =>
          number === undefined ? token : JSON.stringify(number),
      ),
    ) as Value[] | { [key: string]: Value };
  } catch {
    return null; // Partial/streaming JSON and ordinary output remain readable text.
  }
}

function fieldLabel(key: string): string {
  const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function description(value: Value[] | { [key: string]: Value }): string {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  const commitMessage =
    value.commit && typeof value.commit === 'object' && !Array.isArray(value.commit)
      ? value.commit.message
      : null;
  const title = [value.title, value.name, value.message, value.summary, commitMessage].find(
    (candidate) => typeof candidate === 'string' && candidate.trim(),
  );
  return typeof title === 'string' ? title.slice(0, 120) : `${Object.keys(value).length} fields`;
}

function Branch({ label, value }: { label: string; value: Value[] | { [key: string]: Value } }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const preview = description(value);
  return (
    <div className="tool-result-branch">
      <button
        type="button"
        className="tool-result-toggle"
        aria-label={`${label} ${preview}`}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <UiIcon name={open ? 'down' : 'forward'} size={16} />
        <span>{label}</span>
        <span className="tool-result-description">{preview}</span>
      </button>
      <MotionPresence open={open} kind="disclosure" appear={false}>
        <div id={id} className="tool-result-children">
          <Fields value={value} />
        </div>
      </MotionPresence>
    </div>
  );
}

function Fields({ value }: { value: Value[] | { [key: string]: Value } }) {
  const [visible, setVisible] = useState(PAGE_SIZE);
  const entries = Object.entries(value);
  const isList = Array.isArray(value);
  if (!entries.length)
    return <p className="tool-result-empty">{isList ? 'No items' : 'No fields'}</p>;
  return (
    <>
      <dl className="tool-result-fields">
        {entries.slice(0, visible).map(([key, entry]) => {
          const label = isList ? `Item ${Number(key) + 1}` : fieldLabel(key);
          return entry !== null && typeof entry === 'object' ? (
            <div key={key} className="tool-result-field tool-result-field--branch">
              <dt className="sr-only">{label}</dt>
              <dd>
                <Branch label={label} value={entry} />
              </dd>
            </div>
          ) : (
            <div key={key} className="tool-result-field">
              <dt>{label}</dt>
              <dd>{entry === null ? 'null' : entry === '' ? 'Empty string' : String(entry)}</dd>
            </div>
          );
        })}
      </dl>
      {visible < entries.length && (
        <button
          type="button"
          className="tool-result-more"
          onClick={() => setVisible(visible + PAGE_SIZE)}
        >
          Show more ({entries.length - visible} remaining)
        </button>
      )}
    </>
  );
}

/** Presentation only: no summarization, tool-specific actions, or changes to copied data. */
export function ToolResultContent({ text, label = 'Result' }: { text: string; label?: string }) {
  const parsed = useMemo(() => parseResult(text), [text]);
  const [raw, setRaw] = useState(false);
  return (
    <section className="tool-result-content" aria-label={label}>
      <div className="tool-result-toolbar">
        <span className="tool-result-label">{label}</span>
        {parsed !== null && (
          <div className="tool-result-views" aria-label={`${label} view`}>
            <button type="button" aria-pressed={!raw} onClick={() => setRaw(false)}>
              Readable
            </button>
            <button type="button" aria-pressed={raw} onClick={() => setRaw(true)}>
              Raw
            </button>
          </div>
        )}
        <CopyButton text={text} label={`Copy ${label.toLowerCase()}`} />
      </div>
      <div className="tool-result-body" role="region" aria-label={`${label} content`} tabIndex={0}>
        {parsed !== null && !raw ? (
          <Fields key={text} value={parsed} />
        ) : (
          <pre className={raw ? 'tool-result-text tool-result-text--raw' : 'tool-result-text'}>
            {text}
          </pre>
        )}
      </div>
    </section>
  );
}
