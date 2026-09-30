import {
  createCustodianIpcClient,
  validateCustodianMode,
  type CustodianChannel,
} from './symposium-custodian-ipc.js';
/** Evaluated before store/bootstrap imports in both app entry points. */
export const custodianControllerMode = validateCustodianMode(
  process.env.MITZO_SYMPOSIUM_CUSTODIAN_CONTROLLER,
  process.connected === true,
  process.send,
);
export const custodianOwnerMode = process.env.MITZO_SYMPOSIUM_CUSTODIAN_OWNER === '1';
if (custodianControllerMode && custodianOwnerMode)
  throw Error('Custodian cannot also be its app controller');
let broadcast: ((sessionId: string, event: Record<string, unknown>) => void) | undefined;
export function receiveCustodianEvents(listener: typeof broadcast) {
  broadcast = listener;
}
export const custodianControllerClient = custodianControllerMode
  ? createCustodianIpcClient(process as unknown as CustodianChannel, {
      onEvent: (sessionId, event) => broadcast?.(sessionId, event),
    })
  : undefined;
if (custodianControllerMode) process.once('disconnect', () => process.exit(1));
