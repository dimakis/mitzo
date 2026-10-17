import { useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMotionPresence } from '../hooks/useMotionPresence';
import {
  QuickSettingsContext,
  useQuickSettings,
  type SettingsPage,
} from '../lib/quick-settings-context';
import { UiIcon } from './UiIcon';
import { ModelBrandMark } from './SettingsBrandMark';
import './QuickChatSettings.css';

/** A summary and the original editor share one mounted lifetime. */
export function QuickSettingsField({
  page,
  title,
  value,
  children,
  mark,
  parent,
  onOpen,
  selected,
  readOnly,
  add = false,
}: {
  page: SettingsPage;
  title: string;
  value: string;
  children: ReactNode;
  mark?: ReactNode;
  parent?: SettingsPage;
  onOpen?: () => void;
  selected?: string;
  readOnly?: boolean;
  add?: boolean;
}) {
  const navigation = useQuickSettings();
  const id = useId();
  const active = navigation?.page?.key === page;
  const { ref, present } = useMotionPresence(active, 'popover', false);
  if (!navigation) return children;
  const visible = (navigation.page?.key ?? null) === (parent ?? null);
  const target = navigation.summaryRoot?.querySelector(`[data-settings-slot="${page}"]`);
  const row = (
    <button
      type="button"
      className={`quick-settings-row${add ? ' quick-settings-row--add' : ''}`}
      hidden={!visible}
      data-quick-setting={page}
      data-value={selected}
      data-readonly={readOnly || undefined}
      aria-label={`${title}, ${value}`}
      aria-controls={id}
      aria-expanded={active}
      onClick={() => {
        onOpen?.();
        navigation.navigate({ key: page, title, parent });
      }}
    >
      <span className="quick-settings-label">{title}</span>
      <span className="quick-settings-value">
        {mark}
        <span>{value}</span>
        <UiIcon name={add ? 'plus' : 'forward'} size={16} />
      </span>
    </button>
  );
  return (
    <div className="quick-settings-field">
      {target ? createPortal(row, target) : row}
      <div
        id={id}
        ref={ref}
        role="region"
        aria-label={`${title} options`}
        className={`quick-settings-editor${!active ? ' quick-settings-editor--exiting' : ''}`}
        hidden={!present}
        inert={!active}
        aria-hidden={!active || undefined}
      >
        <QuickSettingsContext.Provider value={null}>{children}</QuickSettingsContext.Provider>
      </div>
    </div>
  );
}

export function QuickSettingsSupplement({
  page,
  children,
}: {
  page: SettingsPage;
  children: ReactNode;
}) {
  const navigation = useQuickSettings();
  if (!navigation) return children;
  return (
    <div className="quick-settings-supplement" hidden={navigation.page?.key !== page}>
      {children}
    </div>
  );
}

export function QuickSettingsChoices({
  title,
  value,
  choices,
  disabled,
  onChange,
}: {
  title: string;
  value: string;
  choices: { id: string; label: string; disabled?: boolean }[];
  disabled?: boolean;
  onChange(value: string): void;
}) {
  return (
    <div className="quick-settings-choices" role="group" aria-label={title}>
      {choices.map((choice) => (
        <button
          key={choice.id}
          type="button"
          className="quick-settings-choice"
          data-setting-value={choice.id}
          aria-pressed={value === choice.id}
          disabled={disabled || choice.disabled}
          onClick={() => onChange(choice.id)}
        >
          <span>
            {title === 'Model' && <ModelBrandMark model={choice.id} label={choice.label} />}
            {choice.label}
          </span>
          {value === choice.id && <UiIcon name="check" size={16} />}
        </button>
      ))}
      {!choices.length && <p role="status">No choices are available.</p>}
      {disabled && <p className="quick-settings-note">Changes are unavailable right now.</p>}
    </div>
  );
}
