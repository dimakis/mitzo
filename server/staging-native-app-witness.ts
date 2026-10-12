export interface StagingAcceptedAppSourceObservation {
  readonly nativeSourceCommit: string;
  readonly acceptedAppCommit: string;
  readonly appRoot: string;
  readonly instanceId: string;
  readonly custodianPid: number;
  readonly epoch: number;
  readonly controllerPid: number;
  readonly compatibilitySha256: string;
}
export interface OriginalStagingAppSourceWitness {
  capture(): StagingAcceptedAppSourceObservation;
}
const witnesses = new WeakSet<object>();
const refuse = () => Error('Actual original accepted-app source witness unavailable');
/** Trusted original launcher construction only. Metadata remains observation;
 * the callback must recheck original custody, accepted source compatibility and
 * latest awaited child. JSON cannot recreate this same-process carrier. */
export function createOriginalStagingAppSourceWitness(
  capture: () => StagingAcceptedAppSourceObservation,
): OriginalStagingAppSourceWitness {
  if (typeof capture !== 'function') throw refuse();
  const witness = Object.freeze({ capture });
  witnesses.add(witness);
  return witness;
}
export function captureOriginalStagingAppSource(
  witness: OriginalStagingAppSourceWitness,
  nativeSourceCommit: string,
  ownerInstance: string,
): Readonly<StagingAcceptedAppSourceObservation> {
  if (!witnesses.has(witness)) throw refuse();
  const value: unknown = witness.capture();
  if (value instanceof Promise) {
    void value.catch(() => {});
    throw refuse();
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).sort().join() !==
      'acceptedAppCommit,appRoot,compatibilitySha256,controllerPid,custodianPid,epoch,instanceId,nativeSourceCommit'
  )
    throw refuse();
  const observation = value as StagingAcceptedAppSourceObservation;
  if (
    observation.nativeSourceCommit !== nativeSourceCommit ||
    !/^[a-f0-9]{40}$/.test(nativeSourceCommit) ||
    !/^[a-f0-9]{40}$/.test(observation.acceptedAppCommit) ||
    observation.instanceId !== ownerInstance ||
    observation.custodianPid !== process.pid ||
    !Number.isSafeInteger(observation.epoch) ||
    observation.epoch < 1 ||
    !Number.isSafeInteger(observation.controllerPid) ||
    observation.controllerPid < 2 ||
    observation.controllerPid === process.pid ||
    typeof observation.appRoot !== 'string' ||
    !observation.appRoot.endsWith('/releases/' + observation.acceptedAppCommit.slice(0, 12)) ||
    !/^[a-f0-9]{64}$/.test(observation.compatibilitySha256)
  )
    throw refuse();
  return Object.freeze({ ...observation });
}
