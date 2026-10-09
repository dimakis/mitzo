import { discoveryClaimLabel } from './symposium-model-discovery.js';
import {
  RoutingNetworkObservationSchema,
  type RoutingNetworkObservation,
} from './symposium-discovery-diagnostics.js';
/** Actual selected supervisor shorthand format, not arbitrary tracing JSON/messages.
 * Raw console data is transient and never copied into a receipt, error or result. */
export function projectRoutingConsole(console: string): RoutingNetworkObservation {
  const unavailable: RoutingNetworkObservation = {
    source: 'owned-supervisor-console-v1',
    availability: 'unavailable',
    observations: [],
  };
  if (Buffer.byteLength(console) > 131072) return unavailable;
  const observations: RoutingNetworkObservation['observations'] = [];
  const grammar =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) DEBUG openshell\.routing_http: routing diagnostic v1 kind=account_check method=GET outcome=(response|credential_unavailable|transport_failed|relay_failed|malformed_response) request_ordinal=([1-9][0-9]{0,15})(?: status_code=([1-5][0-9]{2}))?$/;
  for (const line of console.split('\n')) {
    const match = grammar.exec(line);
    if (!match) continue;
    observations.push({
      kind: 'account_check',
      method: 'GET',
      outcome: match[2] as RoutingNetworkObservation['observations'][number]['outcome'],
      requestOrdinal: Number(match[3]),
      recordedAt: match[1],
      ...(match[4] ? { statusCode: Number(match[4]) } : {}),
    });
    if (observations.length > 32) return unavailable;
  }
  const parsed = RoutingNetworkObservationSchema.safeParse({
    source: 'owned-supervisor-console-v1',
    availability: observations.length ? 'captured' : 'unavailable',
    observations,
  });
  return parsed.success ? parsed.data : unavailable;
}

export interface RoutingCaptureInput {
  receipt: import('./symposium-model-discovery.js').DiscoveryReceipt;
  workspace: string;
  namespace: string;
  supervisorImage: string;
  assertCurrent(): Promise<void>;
  inventory(): Promise<unknown>;
  imageId(containerId: string): Promise<unknown>;
  loggingFilter(containerId: string): Promise<unknown>;
  readConsole(containerId: string): Promise<string>;
}
/** Read-only capabilities scoped to the original namespace and exact creation receipt.
 * A workload's stdout and a replacement supervisor cannot supply observations. */
export async function captureRoutingConsole(
  input: RoutingCaptureInput,
): Promise<RoutingNetworkObservation> {
  const { receipt } = input;
  const check = async () => {
    try {
      await input.assertCurrent();
    } catch {
      throw Error('Routing observation custody changed');
    }
  };
  const checked = async <T>(read: () => Promise<T>) => {
    await check();
    const result = await read();
    await check();
    return result;
  };
  const select = async () => {
    const inventory = await checked(input.inventory);
    if (!Array.isArray(inventory) || !receipt.id)
      throw Error('Routing observation identity unavailable');
    const matches = inventory.filter(
      (row) =>
        row?.Labels?.['openshell.ai/isolation-role'] === 'supervisor' &&
        (row?.Labels?.['openshell.ai/sandbox-id'] === receipt.id ||
          row?.Labels?.['openshell.ai/sandbox-name'] === receipt.name),
    );
    if (matches.length !== 1) throw Error('Routing observation identity ambiguous');
    const row = matches[0];
    const labels = row.Labels;
    const expected = {
      'openshell.ai/sandbox-id': receipt.id,
      'openshell.ai/sandbox-name': receipt.name,
      'openshell.ai/sandbox-workspace': input.workspace,
      'openshell.ai/sandbox-namespace': input.namespace,
      'openshell.ai/isolation-role': 'supervisor',
      'openshell.managed': 'true',
      'mitzo.discovery': 'models',
      'mitzo.discovery.claim': discoveryClaimLabel(receipt.claim),
    };
    const names = Array.isArray(row.Names)
      ? row.Names
      : typeof row.Names === 'string'
        ? [row.Names]
        : [];
    if (
      typeof row.Id !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.Id) ||
      names.length !== 1 ||
      names[0] !== `openshell-supervisor-${receipt.id}` ||
      Object.entries(expected).some(([key, value]) => labels[key] !== value)
    )
      throw Error('Routing observation identity changed');
    const observed = await checked(() => input.imageId(row.Id));
    const imageId =
      typeof observed === 'string' && /^[a-f0-9]{64}$/.test(observed)
        ? `sha256:${observed}`
        : observed;
    if (imageId !== input.supervisorImage || !/^sha256:[a-f0-9]{64}$/.test(input.supervisorImage))
      throw Error('Routing observation image changed');
    if ((await checked(() => input.loggingFilter(row.Id))) !== 'L')
      throw Error('Routing observation logging filter changed');
    return row.Id as string;
  };
  const id = await select();
  const console = await checked(() => input.readConsole(id));
  if ((await select()) !== id) throw Error('Routing observation identity changed');
  return projectRoutingConsole(console);
}

/** Go-template builtins only. Emits fixed markers, never environment values. */
export const ROUTING_LOGGING_FILTER_TEMPLATE =
  '{{range .Config.Env}}{{if and (ge (len .) 9) (eq (slice . 0 9) "RUST_LOG=")}}R{{end}}{{if eq . "OPENSHELL_LOG_LEVEL=off,openshell.routing_http=debug"}}L{{end}}{{end}}';
