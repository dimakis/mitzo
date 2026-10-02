import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(fileURLToPath(import.meta.url), '..', '..');

export function localServerUsesTls(): boolean {
  return (
    existsSync(join(projectRoot, 'certs', 'cert.pem')) &&
    existsSync(join(projectRoot, 'certs', 'key.pem'))
  );
}

/** Internal calls use the plain HTTP listener, which moves to PORT + 1 under TLS. */
export function localHttpBaseUrl(port: number, useTls: boolean): string {
  return `http://localhost:${useTls ? port + 1 : port}`;
}
