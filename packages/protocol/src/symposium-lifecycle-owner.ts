import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync } from 'node:fs';

export interface SymposiumLifecycleOwner {
  domain: string;
  pid: number;
}

/** A boot and PID namespace identify the local kernel process domain. Unknown
 * ownership remains durable but cannot be reclaimed. No clock-based expiry. */
export function localSymposiumLifecycleOwner(): SymposiumLifecycleOwner | null {
  try {
    let boot: string, namespace: string;
    if (process.platform === 'linux') {
      boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      namespace = readlinkSync('/proc/self/ns/pid');
      if (!/^pid:\[[0-9]+\]$/.test(namespace)) return null;
    } else if (process.platform === 'darwin') {
      boot = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
        timeout: 1000,
        maxBuffer: 1024,
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      namespace = 'darwin-host';
    } else return null;
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(boot)) return null;
    return {
      domain: createHash('sha256')
        .update(`${process.platform}:${boot.toLowerCase()}:${namespace}`)
        .digest('hex'),
      pid: process.pid,
    };
  } catch {
    return null;
  }
}

/** ESRCH in the same kernel domain proves the original process is gone. A live
 * or reused PID, permission error, reboot or unknown namespace is a refusal. */
export function originalSymposiumLifecycleOwnerGone(owner: SymposiumLifecycleOwner): boolean {
  const local = localSymposiumLifecycleOwner();
  if (
    !local ||
    !owner ||
    !/^[a-f0-9]{64}$/.test(owner.domain) ||
    owner.domain !== local.domain ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid < 1
  )
    return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
