import { execFile } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { readBackupPassword } from './host.js';

export function backupKeychainService(root: string) {
  return 'mitzo.backup.' + createHash('sha256').update(resolve(root)).digest('hex');
}
// Add only. A repeated request must prove the existing password; it cannot rotate it.
// The secret enters the native API through stdin, never argv or a file.
export const CREATE_BACKUP_PASSWORD = String.raw`
import ctypes, json, re, sys
F=ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
S=ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')
P=ctypes.c_void_p
def api(lib,name,result,args):
    fn=getattr(lib,name); fn.restype=result; fn.argtypes=args; return fn
def const(lib,name): return P.in_dll(lib,name).value
string=api(F,'CFStringCreateWithCString',P,[P,ctypes.c_char_p,ctypes.c_uint32])
data=api(F,'CFDataCreate',P,[P,P,ctypes.c_long])
dictionary=api(F,'CFDictionaryCreate',P,[P,P,P,ctypes.c_long,P,P])
add=api(S,'SecItemAdd',ctypes.c_int32,[P,ctypes.POINTER(P)])
try:
    request=json.loads(sys.stdin.buffer.read(32769))
    if set(request) != {'service','password'} or not re.fullmatch(r'mitzo\.backup\.[a-f0-9]{64}',request['service']): raise ValueError()
    password=request['password']
    if not isinstance(password,str) or not 16<=len(password)<=4096 or any(c in password for c in ['\n','\r','\x00']): raise ValueError()
    encoded=password.encode('utf8'); buffer=ctypes.create_string_buffer(encoded)
    values={const(S,'kSecClass'):const(S,'kSecClassGenericPassword'),
        const(S,'kSecAttrService'):string(None,request['service'].encode(),0x08000100),
        const(S,'kSecAttrAccount'):string(None,b'repository',0x08000100),
        const(S,'kSecAttrLabel'):string(None,b'Mitzo backup password',0x08000100),
        const(S,'kSecValueData'):data(None,buffer,len(encoded))}
    keys=(P*len(values))(*values.keys()); vals=(P*len(values))(*values.values())
    attributes=dictionary(None,keys,vals,len(values),
        ctypes.addressof(ctypes.c_byte.in_dll(F,'kCFTypeDictionaryKeyCallBacks')),
        ctypes.addressof(ctypes.c_byte.in_dll(F,'kCFTypeDictionaryValueCallBacks')))
    status=add(attributes,None)
    if status == -25299: print('{"exists":true}')
    elif status == 0: print('{"ok":true}')
    else: raise ValueError()
except Exception:
    print('{"ok":false}'); sys.exit(1)
`;
type Run = (input: string) => Promise<string>;
const run: Run = (input) =>
  new Promise((accept, reject) => {
    const child = execFile(
      '/usr/bin/python3',
      ['-I', '-c', CREATE_BACKUP_PASSWORD],
      { env: { PATH: '/usr/bin:/bin' }, timeout: 15000, maxBuffer: 1024 },
      (error, stdout) => (error ? reject(Error('Backup credential unavailable')) : accept(stdout)),
    );
    child.stdin?.on('error', () => reject(Error('Backup credential unavailable')));
    child.stdin?.end(input);
  });
const exec = promisify(execFile);
export class BackupKeychain {
  private readonly service: string;
  constructor(
    root: string,
    private readonly create: Run = run,
    private readonly lookup: () => Promise<string> = async () => {
      const { stdout } = await exec(
        '/usr/bin/security',
        ['find-generic-password', '-s', this.service, '-a', 'repository', '-w'],
        { env: { PATH: '/usr/bin:/bin' }, timeout: 10000, maxBuffer: 32768 },
      );
      return stdout;
    },
  ) {
    this.service = backupKeychainService(root);
  }
  read() {
    return readBackupPassword(async () => this.lookup());
  }
  async save(password: string) {
    try {
      const result = JSON.parse(
        await this.create(JSON.stringify({ service: this.service, password })),
      ) as { ok?: boolean; exists?: boolean };
      if (result.ok !== true && result.exists !== true) throw Error();
      // Verify both new and retried entries using the same reader that Restic uses.
      const saved = Buffer.from(await this.read());
      const supplied = Buffer.from(password);
      if (saved.length !== supplied.length || !timingSafeEqual(saved, supplied)) throw Error();
    } catch {
      throw Error('Backup credential unavailable');
    }
  }
}
