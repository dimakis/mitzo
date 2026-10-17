import { UiIcon } from './UiIcon';
import './SettingsBrandMark.css';

export function ModelBrandMark({ model, label = '' }: { model: string; label?: string }) {
  const identity = `${model} ${label}`;
  const brand = /\bclaude(?:[-\s._]|$)/i.test(identity)
    ? 'claude'
    : /\b(?:gpt|chatgpt|codex)(?:[-\s._]|$)|\bo[134](?:[-\s._]|$)/i.test(identity)
      ? 'openai'
      : null;
  return brand ? <span className={`model-brand model-brand--${brand}`} aria-hidden="true" /> : null;
}

export function RuntimeBrandMark({ location }: { location?: 'openshell' | 'local' }) {
  return location === 'openshell' ? (
    <span className="openshell-brand" aria-hidden="true" />
  ) : location === 'local' ? (
    <UiIcon name="laptop" size={20} />
  ) : null;
}
