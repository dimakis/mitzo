import { isAbsolute } from 'node:path';

/** Pure composition only. The controller supplies its exact source-qualified
 * original and target builds; neither a CLI argument nor a plan selects a build. */
export function createOwnedRoutingProposal(old, devicePin, routingPin, original, target) {
  const gateway = old?.gateway;
  if (
    !gateway ||
    !original ||
    !target ||
    gateway.cliSha256 !== original.cliSha256 ||
    gateway.executableSha256 !== original.gatewaySha256 ||
    gateway.workloadImage !== original.image ||
    gateway.sandboxRuntimeImage !== original.sandboxRuntimeImage ||
    gateway.supervisorImage !== original.supervisorImage ||
    !isAbsolute(routingPin?.executable ?? '') ||
    !/^[a-f0-9]{64}$/.test(routingPin?.sha256 ?? '') ||
    routingPin.sha256 !== target.cliSha256 ||
    !/^sha256:[a-f0-9]{64}$/.test(target.supervisorImage ?? '') ||
    target.cliSha256 === original.cliSha256 ||
    target.supervisorImage === original.supervisorImage ||
    ['gatewaySha256', 'image', 'imageDigest', 'sandboxRuntimeImage', 'nativeArtifacts'].some(
      (key) => JSON.stringify(target[key]) !== JSON.stringify(original[key]),
    )
  )
    throw Error('Exact narrow routing native successor required');
  return {
    ...old,
    gateway: {
      ...gateway,
      cliExecutable: routingPin.executable,
      cliSha256: routingPin.sha256,
      supervisorImage: target.supervisorImage,
    },
    personal: { ...old.personal, deviceLoginExecutable: devicePin },
  };
}
