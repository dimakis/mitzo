import { dirname, extname, join } from 'path';
import { fileURLToPath } from 'url';

export interface BundledMcpEntrypoint {
  command: string;
  args: string[];
}

export function resolveBundledMcpEntrypoint(
  moduleUrl: string,
  serverName: string,
): BundledMcpEntrypoint {
  const modulePath = fileURLToPath(moduleUrl);
  const serverDirectory = dirname(modulePath);

  if (extname(modulePath) === '.ts') {
    return {
      command: 'node',
      args: ['--import', 'tsx', join(serverDirectory, `${serverName}.ts`)],
    };
  }

  return {
    command: 'node',
    args: [join(serverDirectory, `${serverName}.js`)],
  };
}
