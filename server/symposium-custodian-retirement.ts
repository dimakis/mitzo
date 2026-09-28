import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export interface CustodianRetirementReceiptInput {
  stateParent: string;
  gatewayStateDirectory: string;
  instanceId: string;
  controllerGeneration: number;
}

export interface CustodianRetirementReceipt {
  version: 1;
  gatewayStateDirectory: string;
  instanceId: string;
  controllerGeneration: number;
  completedAt: number;
}

const receiptName = 'custodian-retirement.json';
function privateParent(path: string) {
  if (!isAbsolute(path)) throw Error('Retirement state parent must be absolute');
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077
  )
    throw Error('Retirement state parent must be private and owned');
}

/** The original parent calls this only after its exact gateway child has exited
 * and every retained runtime/host cleanup has been confirmed. O_EXCL means an
 * old terminal receipt cannot be silently replaced by a later launch. */
export function writeCustodianRetirementReceipt(input: CustodianRetirementReceiptInput): void {
  privateParent(input.stateParent);
  if (
    !isAbsolute(input.gatewayStateDirectory) ||
    dirname(resolve(input.gatewayStateDirectory)) !== resolve(input.stateParent) ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(input.instanceId) ||
    !Number.isSafeInteger(input.controllerGeneration) ||
    input.controllerGeneration < 1
  )
    throw Error('Retirement receipt identity is invalid');
  privateParent(input.gatewayStateDirectory);
  const receipt: CustodianRetirementReceipt = {
    version: 1,
    gatewayStateDirectory: input.gatewayStateDirectory,
    instanceId: input.instanceId,
    controllerGeneration: input.controllerGeneration,
    completedAt: Date.now(),
  };
  const path = join(input.stateParent, receiptName);
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, JSON.stringify(receipt));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const parent = openSync(input.stateParent, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(parent);
  } finally {
    closeSync(parent);
  }
}

export function readCustodianRetirementReceipt(
  stateParent: string,
): CustodianRetirementReceipt | null {
  privateParent(stateParent);
  const path = join(stateParent, receiptName);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 2048
    )
      throw Error('Retirement receipt is not a private regular file');
    const value: unknown = JSON.parse(readFileSync(fd, 'utf8'));
    if (!value || typeof value !== 'object') throw Error('Retirement receipt is invalid');
    const receipt = value as Record<string, unknown>;
    if (
      Object.keys(receipt).sort().join() !==
        'completedAt,controllerGeneration,gatewayStateDirectory,instanceId,version' ||
      receipt.version !== 1 ||
      typeof receipt.gatewayStateDirectory !== 'string' ||
      dirname(resolve(receipt.gatewayStateDirectory)) !== resolve(stateParent) ||
      typeof receipt.instanceId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(receipt.instanceId) ||
      !Number.isSafeInteger(receipt.controllerGeneration) ||
      Number(receipt.controllerGeneration) < 1 ||
      !Number.isSafeInteger(receipt.completedAt) ||
      Number(receipt.completedAt) < 1
    )
      throw Error('Retirement receipt is invalid');
    privateParent(receipt.gatewayStateDirectory);
    return receipt as unknown as CustodianRetirementReceipt;
  } finally {
    closeSync(fd);
  }
}

export async function finishCustodianRetirement(
  deps: {
    begin(): void;
    retireRuntimes(signal: AbortSignal): Promise<void>;
    drainHost(signal: AbortSignal): Promise<void>;
    closeHost(signal: AbortSignal): Promise<void>;
    record(): void;
  },
  signal: AbortSignal,
): Promise<void> {
  deps.begin();
  const results = await Promise.allSettled([
    Promise.resolve().then(() => deps.retireRuntimes(signal)),
    Promise.resolve().then(() => deps.drainHost(signal)),
  ]);
  signal.throwIfAborted();
  if (results.some((result) => result.status === 'rejected'))
    throw Error('Custodian retirement cleanup remains uncertain');
  await deps.closeHost(signal);
  signal.throwIfAborted();
  deps.record();
}
