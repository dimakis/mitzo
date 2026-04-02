import { DEFAULT_MODEL } from './constants';

export const PREFERRED_MODEL_KEY = 'mitzo-preferred-model';

export function getPreferredModel(): string {
  try {
    return localStorage.getItem(PREFERRED_MODEL_KEY) || DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

export function setPreferredModel(modelId: string): void {
  try {
    localStorage.setItem(PREFERRED_MODEL_KEY, modelId);
  } catch {
    // localStorage unavailable — silently ignore
  }
}
