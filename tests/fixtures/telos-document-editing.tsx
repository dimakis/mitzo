import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { FileViewer } from '../../frontend/src/pages/FileViewer';
import '../../frontend/src/styles/tokens.css';
import '../../frontend/src/styles/global.css';
import '../../frontend/src/styles/appearance.css';

createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <FileViewer />
  </BrowserRouter>,
);
