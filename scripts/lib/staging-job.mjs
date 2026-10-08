export function assertStageJob(
  { pid, birth, cwd, portPids, protectedPids },
  receipt,
  expected = { pid, birth },
) {
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    !birth ||
    typeof expected !== 'object' ||
    pid !== expected.pid ||
    birth !== expected.birth ||
    protectedPids.includes(pid) ||
    cwd !== receipt.release ||
    portPids.length !== 1 ||
    portPids[0] !== pid
  )
    throw Error('Original staging job/listener mismatch; refuse control');
}
