import { useParams } from 'react-router-dom';
import { TodoView } from './TodoView';
import { TodoDetailView } from './TodoDetailView';

/** The frozen workspace opens a focused item on both platforms. Collection
 * preferences and scroll are retained by their existing navigation owners. */
export function TodoWorkspace() {
  const { id } = useParams<{ id: string }>();
  return id ? <TodoDetailView key={id} /> : <TodoView />;
}
