import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, useSearchParams } from 'react-router-dom';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/appearance.css';
import '../../frontend/src/styles/workspace.css';
import { WorkOutputs } from '../../frontend/src/components/WorkOutputs';
import { FileViewer } from '../../frontend/src/pages/FileViewer';
function WorkRoute() {
  const [params] = useSearchParams();
  return (
    <main>
      <WorkOutputs itemId={params.get('item')!} />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <Routes>
      <Route path="/work" element={<WorkRoute />} />
      <Route path="/files" element={<FileViewer />} />
    </Routes>
  </BrowserRouter>,
);
