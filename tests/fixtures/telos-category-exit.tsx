import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { TelosOutcomesTree } from '../../frontend/src/components/TelosOutcomesTree';
import { createTelosWorkFixtures } from '../../frontend/src/test-utils/telos-work-fixtures';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/motion.css';

const record = {
  ...createTelosWorkFixtures().homeStudio.items[0],
  itemId: 'category-exit-item',
  parentId: null,
  categories: ['Job'],
  summary: 'Open the reviewed outcome',
};
function Tree() {
  const navigate = useNavigate();
  return (
    <TelosOutcomesTree
      records={[record]}
      refreshKey={0}
      onOpen={(id) => navigate(`/todos/${encodeURIComponent(id)}`)}
    />
  );
}
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <Routes>
      <Route path="/todos" element={<Tree />} />
      <Route path="/todos/:id" element={<h1>Reviewed outcome opened</h1>} />
    </Routes>
  </BrowserRouter>,
);
