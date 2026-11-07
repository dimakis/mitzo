import type { SessionLaunchConfig } from '@mitzo/protocol';
import type { useSessionLaunchDefaults } from '../hooks/useSessionLaunchDefaults';
import { QuickSettingsField } from './QuickChatSettings';
import { setDefaultAccountModel } from '../lib/account-preference';

export function SessionLaunchDefaultsControl({
  configuration,
  defaults,
  disabled = false,
}: {
  configuration: SessionLaunchConfig | null;
  defaults: ReturnType<typeof useSessionLaunchDefaults>;
  disabled?: boolean;
}) {
  return (
    <QuickSettingsField
      page="defaults"
      title="New-chat defaults"
      value={defaults.loading ? 'Loading…' : defaults.configuration ? 'Saved' : 'Not set'}
    >
      <button
        type="button"
        disabled={
          disabled ||
          !configuration ||
          defaults.loading ||
          defaults.saving ||
          defaults.revision === undefined
        }
        onClick={() => {
          if (configuration) void defaults.save(configuration);
        }}
      >
        {defaults.saving ? 'Saving…' : 'Make default for new chats'}
      </button>
      {defaults.configuration && (
        <button
          type="button"
          disabled={disabled || defaults.loading || defaults.saving}
          onClick={() => {
            void defaults.save(null).then((saved) => {
              if (saved) setDefaultAccountModel(null);
            });
          }}
        >
          Clear new-chat default
        </button>
      )}
      <p>
        Save the complete agent configuration, including Run on and its host, for new chats on all
        your devices.
      </p>
      {defaults.error && <p role="alert">{defaults.error}</p>}
      {(defaults.error || defaults.revision === undefined) && (
        <button
          type="button"
          disabled={defaults.loading || defaults.saving}
          onClick={defaults.refresh}
        >
          Retry session defaults
        </button>
      )}
    </QuickSettingsField>
  );
}
