import type { MitzoMode } from '@mitzo/protocol';

export interface ContextBlockEntry {
  name: string;
  path: string;
  sizeBytes: number;
}

export interface SkillMetadata {
  name: string;
  source: 'repo' | 'user' | 'bundled';
  description?: string;
}

export interface ConfigState {
  contextBlocks: Record<string, ContextBlockEntry>;
  skills: SkillMetadata[];
  mode: MitzoMode;
  modelId: string | null;
}

export const INITIAL_CONFIG_STATE: ConfigState = {
  contextBlocks: {},
  skills: [],
  mode: 'auto',
  modelId: null,
};
