export interface VertexSeatPolicyOptions {
  project: string;
  region: string;
  model: string;
  claudeBinary: string;
  providerName: string;
}
export function createVertexSeatPolicy(options: VertexSeatPolicyOptions): {
  version: number;
  network_policies: Record<string, unknown>;
};
export function writeVertexSeatPolicy(path: string, options: VertexSeatPolicyOptions, filesystemPolicy?: unknown): Promise<void>;
