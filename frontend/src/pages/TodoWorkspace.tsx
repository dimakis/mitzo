import { useParams } from 'react-router-dom';
import { useIsDesktop } from '../hooks/useMediaQuery';
import { TodoView } from './TodoView';
import { TodoDetailView } from './TodoDetailView';

/** Keep the collection mounted as desktop selection changes, retaining filters and scroll. */
export function TodoWorkspace() {
  const { id } = useParams<{ id: string }>();
  const isDesktop = useIsDesktop();
  if (!isDesktop) return id ? <TodoDetailView key={id} /> : <TodoView />;

  return (
    <main className="workspace-work">
      <div className="workspace-work-heading">
        <p className="workspace-muted">TELOS</p>
        <h1>Work with purpose</h1>
        <p className="workspace-muted">Choose a priority. Review its context and next step.</p>
      </div>
      <div className="workspace-work-panels">
        <section className="workspace-work-list" aria-label="Work items">
          <TodoView selectedId={id} />
        </section>
        <section className="workspace-work-detail" aria-label="Work details">
          {id ? (
            <TodoDetailView key={id} />
          ) : (
            <div className="workspace-work-placeholder">
              <h2>Select a work item</h2>
              <p>Its next step, sub-tasks and source context will appear here.</p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
