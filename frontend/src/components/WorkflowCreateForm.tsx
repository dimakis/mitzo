import { useState, useEffect } from 'react';
import { apiFetch } from '../lib/api-fetch';

interface TemplateVariable {
  description: string;
  default?: string;
}

interface WorkflowTemplate {
  id: string;
  name: string;
  description: string | null;
  variables: Record<string, TemplateVariable> | null;
}

interface WorkflowCreateFormProps {
  onCreated: () => void;
  onCancel: () => void;
}

export function WorkflowCreateForm({ onCreated, onCancel }: WorkflowCreateFormProps) {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [title, setTitle] = useState('');
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch('/api/templates')
      .then((r) => r.json())
      .then((data: WorkflowTemplate[]) => {
        setTemplates(data);
        if (data.length > 0) {
          setSelectedId(data[0].id);
          initVars(data[0]);
        }
      })
      .catch(() => setError('Failed to load templates'));
  }, []);

  function initVars(tmpl: WorkflowTemplate) {
    const vars: Record<string, string> = {};
    if (tmpl.variables) {
      for (const [key, v] of Object.entries(tmpl.variables)) {
        vars[key] = v.default ?? '';
      }
    }
    setVariables(vars);
    setTitle(`${tmpl.name}`);
  }

  function handleTemplateChange(id: string) {
    setSelectedId(id);
    const tmpl = templates.find((t) => t.id === id);
    if (tmpl) initVars(tmpl);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedId || !title.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch('/api/workflows/instantiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateId: selectedId,
          title: title.trim(),
          variables,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
      }
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workflow');
    } finally {
      setSubmitting(false);
    }
  }

  const selected = templates.find((t) => t.id === selectedId);

  return (
    <form className="workflow-create-form" onSubmit={handleSubmit}>
      <div className="workflow-create-field">
        <label htmlFor="wf-template">Template</label>
        <select
          id="wf-template"
          value={selectedId}
          onChange={(e) => handleTemplateChange(e.target.value)}
        >
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>

      {selected?.description && <p className="workflow-create-desc">{selected.description}</p>}

      <div className="workflow-create-field">
        <label htmlFor="wf-title">Title</label>
        <input
          id="wf-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Workflow title"
        />
      </div>

      {selected?.variables &&
        Object.entries(selected.variables).map(([key, v]) => (
          <div className="workflow-create-field" key={key}>
            <label htmlFor={`wf-var-${key}`}>{key}</label>
            <input
              id={`wf-var-${key}`}
              value={variables[key] ?? ''}
              onChange={(e) => setVariables((prev) => ({ ...prev, [key]: e.target.value }))}
              placeholder={v.description}
            />
          </div>
        ))}

      {error && <p className="workflow-create-error">{error}</p>}

      <div className="task-create-actions">
        <button type="submit" className="task-create-submit" disabled={submitting || !title.trim()}>
          {submitting ? 'Creating...' : 'Create Workflow'}
        </button>
        <button type="button" className="task-create-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
