import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { Login } from './pages/Login';
import { SessionList } from './pages/SessionList';
import { ChatView } from './pages/ChatView';
import { FileViewer } from './pages/FileViewer';
import { ErrorBoundary } from './components/ErrorBoundary';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const [auth, setAuth] = useState<'loading' | 'ok' | 'denied'>('loading');
  useEffect(() => {
    fetch('/api/auth/check')
      .then((r) => setAuth(r.ok ? 'ok' : 'denied'))
      .catch(() => setAuth('denied'));
  }, []);
  if (auth === 'denied') return <Navigate to="/login" replace />;
  if (auth === 'loading') {
    return <div style={{ background: 'var(--bg)', minHeight: '100dvh' }} />;
  }
  return <>{children}</>;
}

export function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <SessionList />
              </ProtectedRoute>
            }
          />
          <Route
            path="/chat"
            element={
              <ProtectedRoute>
                <ErrorBoundary>
                  <ChatView />
                </ErrorBoundary>
              </ProtectedRoute>
            }
          />
          <Route
            path="/chat/:sessionId"
            element={
              <ProtectedRoute>
                <ErrorBoundary>
                  <ChatView />
                </ErrorBoundary>
              </ProtectedRoute>
            }
          />
          <Route
            path="/files"
            element={
              <ProtectedRoute>
                <ErrorBoundary>
                  <FileViewer />
                </ErrorBoundary>
              </ProtectedRoute>
            }
          />
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
