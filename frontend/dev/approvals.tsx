import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PermissionBanner } from '../src/components/PermissionBanner';
import { useTheme } from '../src/hooks/useTheme';
import '../src/styles/global.css';

function Preview() {
  const { resolved, setTheme } = useTheme();
  const [kind, setKind] = useState('question');
  const [id, setId] = useState(1);
  const [result, setResult] = useState('');
  return (
    <main style={{ padding: 24, maxWidth: 680, margin: '0 auto' }}>
      <p style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 12 }}>
        MITZO · INTERACTION PREVIEW
      </p>
      <h1 style={{ fontSize: 24, marginBottom: 12 }}>Questions and approvals</h1>
      <p style={{ lineHeight: 1.6 }}>
        This isolated preview uses the real UI component and synthetic requests. It never connects
        to a model or the production backend.
      </p>
      <div style={{ display: 'flex', gap: 12, marginTop: 20 }}>
        <button
          className="perm-banner-btn"
          onClick={() => {
            setKind('question');
            setId(id + 1);
          }}
        >
          Question
        </button>
        <button
          className="perm-banner-btn"
          onClick={() => {
            setKind('approval');
            setId(id + 1);
          }}
        >
          Approval
        </button>
        <button
          className="perm-banner-btn"
          onClick={() => setTheme(resolved === 'dark' ? 'light' : 'dark')}
        >
          {resolved === 'dark' ? 'Light theme' : 'Dark theme'}
        </button>
      </div>
      {result && (
        <p role="status" style={{ marginTop: 20, overflowWrap: 'anywhere' }}>
          {result}
        </p>
      )}
      <PermissionBanner
        key={id}
        permId={`preview-${id}`}
        toolName={kind === 'question' ? 'AskUserQuestion' : 'Bash'}
        title={kind === 'approval' ? 'Run the focused test suite' : undefined}
        toolInput="npm test -- server/__tests__/permission-handler.test.ts"
        tier={kind === 'approval' ? 'elevated' : undefined}
        questions={
          kind === 'question'
            ? [
                {
                  id: 'account',
                  header: 'Account',
                  question: 'Which account should this task use?',
                  multiSelect: false,
                  options: [
                    { label: 'Personal ChatGPT', description: 'Use the signed-in personal plan.' },
                    {
                      label: 'Work account',
                      description: 'Use the explicitly configured work billing profile.',
                    },
                  ],
                },
              ]
            : undefined
        }
        onRespond={(_id, decision, _tool, answers) =>
          setResult(
            answers
              ? `Answer received: ${JSON.stringify(answers)}`
              : `Decision received: ${decision}`,
          )
        }
      />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Preview />);
