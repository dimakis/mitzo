import { useLayoutEffect, useRef, useState } from 'react';
import type { Mockup } from '../lib/mockup-catalog';
import { HtmlPreviewCard } from './HtmlPreviewCard';
import { UiIcon } from './UiIcon';
import './MockupCollection.css';

const PAGE_SIZE = 8;
export function MockupCollection({
  mockups,
  sessionId,
}: {
  mockups: Mockup[];
  sessionId?: string;
}) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [selection, setSelection] = useState<{ id: string; path: string } | null>(null);
  const opener = useRef<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const selected = mockups.find((item) => item.id === selection?.id);
  const revision = selected?.revisions.find((item) => item.path === selection?.path);
  const filtered = mockups.filter((item) =>
    `${item.title} ${item.id}`.toLowerCase().includes(search.toLowerCase()),
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const selectedId = selection?.id;
  useLayoutEffect(() => {
    if (selectedId) back.current?.focus({ preventScroll: true });
    else if (opener.current) {
      const button = Array.from(
        list.current?.querySelectorAll<HTMLButtonElement>('button[data-mockup-id]') ?? [],
      ).find((item) => item.dataset.mockupId === opener.current);
      button?.focus({ preventScroll: true });
    }
  }, [selectedId]);
  return (
    <section className="mockup-collection" aria-label="Conversation mockups">
      {selected && revision ? (
        <>
          <button
            ref={back}
            type="button"
            className="chat-resource-back"
            onClick={() => setSelection(null)}
          >
            <UiIcon name="back" size={16} />
            Back to mockups
          </button>
          <h3>{selected.title}</h3>
          <label className="chat-resource-search">
            Revision
            <select
              value={revision.path}
              onChange={(event) => setSelection({ id: selected.id, path: event.target.value })}
            >
              {selected.revisions.map((item, index) => (
                <option key={item.path} value={item.path}>
                  {item.number === null ? 'Linked file' : `Revision ${item.number}`}
                  {index === 0 && item.number !== null ? ' · Latest' : ''}
                </option>
              ))}
            </select>
          </label>
          <p className="workspace-muted">
            Preview interactions start fresh when changing revisions. Files remain in this chat’s
            workspace.
          </p>
          <HtmlPreviewCard key={revision.path} filePath={revision.path} sessionId={sessionId} />
        </>
      ) : (
        <div ref={list}>
          <p className="workspace-muted">
            {mockups.length} mockup{mockups.length === 1 ? '' : 's'} linked in this chat. Recent
            designs first; earlier revisions stay together.
          </p>
          <label className="chat-resource-search">
            Search mockups
            <input
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(0);
              }}
            />
          </label>
          {filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map((item) => (
            <div className="chat-resource-row" key={item.id}>
              <UiIcon name="layers" size={20} />
              <button
                type="button"
                data-mockup-id={item.id}
                aria-label={`Open ${item.title}`}
                onClick={() => {
                  opener.current = item.id;
                  setSelection({ id: item.id, path: item.revisions[0].path });
                }}
              >
                <strong>{item.title}</strong>
                <small>
                  {item.revisions.length} revision{item.revisions.length === 1 ? '' : 's'}
                  {item.revisions[0].number !== null ? ` · Latest ${item.revisions[0].number}` : ''}
                </small>
                <small>{item.id}</small>
              </button>
              <UiIcon name="forward" size={16} />
            </div>
          ))}
          {!mockups.length ? (
            <p>No mockups linked yet. Ask for a mockup or use /mockup.</p>
          ) : (
            !filtered.length && <p>No matching mockups.</p>
          )}
          {pageCount > 1 && (
            <nav className="mockup-collection-pagination" aria-label="Mockup pages">
              <button
                type="button"
                aria-label="Previous mockups"
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                Previous
              </button>
              <span aria-live="polite">
                {currentPage + 1} of {pageCount}
              </span>
              <button
                type="button"
                aria-label="Next mockups"
                disabled={currentPage + 1 === pageCount}
                onClick={() => setPage(currentPage + 1)}
              >
                Next
              </button>
            </nav>
          )}
        </div>
      )}
    </section>
  );
}
