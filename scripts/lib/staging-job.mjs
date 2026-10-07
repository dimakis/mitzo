export function assertStageJob({ pid, cwd, portPids, protectedPids }, receipt, expectedPid = pid) {
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    pid !== expectedPid ||
    protectedPids.includes(pid) ||
    cwd !== receipt.release ||
    portPids.length !== 1 ||
    portPids[0] !== pid
  )
    throw Error('Original staging job/listener mismatch; refuse control');
}
