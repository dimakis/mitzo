import { localInventoryFixture } from './local-inventory-fixture';

/** Offline metadata only; no account or runtime probe. */
export function ordinaryRuntimeInventoryFixture() {
  const local = localInventoryFixture();
  return {
    ...local,
    capabilityRevision: 'combined-caps-r1',
    targets: [
      ...local.targets,
      {
        targetId: 'sandbox',
        targetRevision: 'sandbox-r1',
        label: 'OpenShell fixture',
        location: 'openshell' as const,
        harness: 'codex' as const,
      },
    ],
    routes: [
      ...local.routes.map((route) => ({ ...route, capabilityRevision: local.capabilityRevision })),
      { ...local.routes[0], targetId: 'sandbox', capabilityRevision: 'sandbox-caps-r1' },
    ],
    locations: [
      { location: 'openshell' as const, status: 'configured' as const },
      { location: 'local' as const, status: 'configured' as const },
    ],
  };
}
