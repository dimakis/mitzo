/** Admission limits apply to the shared host, not to each submitting session. */
export const STAGING_RESOURCE_BUDGET = Object.freeze({
  memoryFreePercent: 25,
  swapUsedMiB: 2048,
  diskFreeGiB: 20,
  stagingGiB: 48,
  vmMemoryMiB: 4096,
  vmCpus: 2,
  buildHeapMiB: 2048,
  testHeapMiB: 1024,
  workers: 1,
});
export function assessStagingResources(observation, growthGiB = 0) {
  const reasons = [];
  const fields = [
    'memoryFreePercent',
    'pressureLevel',
    'swapUsedMiB',
    'diskFreeGiB',
    'stagingGiB',
    'vmMemoryMiB',
    'vmCpus',
  ];
  if (
    !observation ||
    fields.some((key) => !Number.isFinite(observation[key]) || observation[key] < 0) ||
    !Number.isFinite(growthGiB) ||
    growthGiB < 0
  )
    return { admitted: false, reasons: ['resource-observation-unavailable'] };
  const b = STAGING_RESOURCE_BUDGET;
  if (
    observation.pressureLevel !== 1 ||
    observation.memoryFreePercent < b.memoryFreePercent ||
    observation.swapUsedMiB > b.swapUsedMiB
  )
    reasons.push('host-memory-pressure');
  if (observation.diskFreeGiB - growthGiB < b.diskFreeGiB) reasons.push('host-disk-headroom');
  if (observation.stagingGiB + growthGiB > b.stagingGiB) reasons.push('staging-disk-budget');
  if (observation.vmMemoryMiB > b.vmMemoryMiB || observation.vmCpus > b.vmCpus)
    reasons.push('staging-vm-budget');
  return { admitted: reasons.length === 0, reasons };
}
