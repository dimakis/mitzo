import type { MitzoMode } from '@mitzo/protocol';

const MODE_DESCRIPTIONS: Record<MitzoMode, string> = {
  ask: 'Read-only. Switch to Agent or Auto to make changes.',
  agent: 'File edits allowed; commands ask for approval. Integrations ask for approval.',
  auto: 'File edits and commands allowed. Integrations ask for approval.',
};

export function PermissionModePicker({
  mode,
  onChange,
  disabled = false,
}: {
  mode: MitzoMode;
  disabled?: boolean;
  onChange: (mode: MitzoMode) => void;
}) {
  return (
    <div
      className="mode-pills"
      role="group"
      aria-label="Permission mode. Workspace limits apply in every mode."
    >
      {(['ask', 'agent', 'auto'] as const).map((value) => (
        <button
          key={value}
          className={`mode-pill${mode === value ? ' mode-pill--active' : ''}`}
          aria-pressed={mode === value}
          disabled={disabled}
          title={disabled ? 'Available once chat permissions are confirmed.' : MODE_DESCRIPTIONS[value]}
          aria-description={MODE_DESCRIPTIONS[value]}
          onClick={() => onChange(value)}
        >
          {value.charAt(0).toUpperCase() + value.slice(1)}
        </button>
      ))}
    </div>
  );
}
