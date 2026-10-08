/** Observed callback identity only. This type cannot reconstruct native custody. */
export interface OriginalSymposiumControllerIdentity {
  readonly instanceId: string;
  readonly epoch: number;
  readonly custodianPid: number;
  readonly controllerPid: number;
  readonly state: 'active';
  readonly scope: 'fresh-retained-sessions';
}
