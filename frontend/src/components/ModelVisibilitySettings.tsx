import { useState } from 'react';
import { HomeDialog } from './HomeDialog';
import {
  hiddenPickerModels,
  setHiddenPickerModels,
  useModelVisibility,
} from '../lib/model-visibility';

export function ModelVisibilitySettings({
  accountId,
  accountLabel,
  models,
  disabled = false,
}: {
  accountId: string;
  accountLabel: string;
  models: { id: string; label: string }[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { persistent } = useModelVisibility();
  const hidden = new Set(hiddenPickerModels(accountId));
  const shown = models.filter((model) => !hidden.has(model.id)).length;
  return (
    <>
      <button
        type="button"
        className="workspace-text-link"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        Model picker settings
      </button>
      {open && (
        <HomeDialog title="Model picker settings" onClose={() => setOpen(false)}>
          <div className="model-visibility-settings">
            <p>{accountLabel}</p>
            <p className="workspace-muted">
              Choose which models appear for this account on this browser. New models are shown
              automatically.
            </p>
            <div className="model-visibility-toolbar">
              <span role="status">
                {shown} of {models.length} shown
              </span>
              <button
                type="button"
                className="workspace-text-link"
                onClick={() => setHiddenPickerModels(accountId, [])}
              >
                Show all
              </button>
              <button
                type="button"
                className="workspace-text-link"
                onClick={() =>
                  setHiddenPickerModels(accountId, [...hidden, ...models.map((model) => model.id)])
                }
              >
                Hide all
              </button>
            </div>
            <div className="model-visibility-list">
              {models.map((model) => (
                <label className="model-visibility-option" key={model.id}>
                  <input
                    type="checkbox"
                    checked={!hidden.has(model.id)}
                    onChange={(event) => {
                      const next = new Set(hidden);
                      if (event.target.checked) next.delete(model.id);
                      else next.add(model.id);
                      setHiddenPickerModels(accountId, [...next]);
                    }}
                  />
                  <span>{model.label}</span>
                </label>
              ))}
            </div>
            <p className="workspace-muted">
              Hiding a model only changes the picker. Existing chats keep their model.
            </p>
            <button type="button" className="workspace-primary" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
          {!persistent && (
            <p role="status">
              Browser storage is unavailable. These choices are kept for this tab only.
            </p>
          )}
        </HomeDialog>
      )}
    </>
  );
}
