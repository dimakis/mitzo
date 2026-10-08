import { execFile } from 'node:child_process';
import { z } from 'zod';
import type { CredentialReference } from './credentials.js';
import { KeychainRotationCredentials } from './keychain-rotation-credentials.js';

export function openAIEnrollmentCredentialReference(operationId: string): CredentialReference {
  const id = z.uuid().parse(operationId);
  return { provider: 'keychain', service: 'mitzo.openai.enrollment.' + id, account: 'api-key' };
}
/** SecItemAdd atomically creates secret+marker; duplicates fail and are never updated or deleted. */
export const CREATE_OPENAI_ENROLLMENT_KEYCHAIN_HELPER = String.raw`
import ctypes, hashlib, json, sys, uuid
F = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
S = ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')
P = ctypes.c_void_p
def api(lib, name, result, args):
    fn=getattr(lib,name); fn.restype=result; fn.argtypes=args; return fn
def const(lib,name): return P.in_dll(lib,name).value
string=api(F,'CFStringCreateWithCString',P,[P,ctypes.c_char_p,ctypes.c_uint32])
data=api(F,'CFDataCreate',P,[P,P,ctypes.c_long])
dict_create=api(F,'CFDictionaryCreate',P,[P,P,P,ctypes.c_long,P,P])
add=api(S,'SecItemAdd',ctypes.c_int32,[P,ctypes.POINTER(P)])
def bytes_ref(value):
    buffer=ctypes.create_string_buffer(value); return data(None,buffer,len(value))
try:
    request=json.loads(sys.stdin.buffer.read(65537))
    version=request['version']
    if str(uuid.UUID(version)) != version: raise ValueError()
    if request['service'] != 'mitzo.openai.enrollment.'+version or request['account'] != 'api-key': raise ValueError()
    value=request['value']
    if not isinstance(value,str) or not 0<len(value)<=16384: raise ValueError()
    encoded=value.encode('utf8')
    marker=b'mitzo-openai-key-v1:'+version.encode('ascii')+b':'+hashlib.sha256(encoded).hexdigest().encode('ascii')
    values={const(S,'kSecClass'):const(S,'kSecClassGenericPassword'),
        const(S,'kSecAttrService'):string(None,request['service'].encode(),0x08000100),
        const(S,'kSecAttrAccount'):string(None,b'api-key',0x08000100),
        const(S,'kSecValueData'):bytes_ref(encoded), const(S,'kSecAttrGeneric'):bytes_ref(marker)}
    keys=(P*len(values))(*values.keys()); vals=(P*len(values))(*values.values())
    attributes=dict_create(None,keys,vals,len(values),
        ctypes.addressof(ctypes.c_byte.in_dll(F,'kCFTypeDictionaryKeyCallBacks')),
        ctypes.addressof(ctypes.c_byte.in_dll(F,'kCFTypeDictionaryValueCallBacks')))
    if add(attributes,None) != 0: raise ValueError()
    print('{"ok":true}')
except Exception:
    print('{"error":"KEYCHAIN_CREATION_UNCONFIRMED"}')
    sys.exit(1)
`;
type Run = (stdin: string, signal: AbortSignal) => Promise<string>;
const nativeRun: Run = (stdin, signal) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      '/usr/bin/python3',
      ['-I', '-c', CREATE_OPENAI_ENROLLMENT_KEYCHAIN_HELPER],
      { env: { PATH: '/usr/bin:/bin' }, signal, timeout: 15000, maxBuffer: 65536 },
      (error, stdout) => {
        if (error) reject(new Error('OpenAI Keychain creation could not be confirmed'));
        else resolve(stdout);
      },
    );
    child.stdin?.on('error', () =>
      reject(new Error('OpenAI Keychain creation could not be confirmed')),
    );
    child.stdin?.end(stdin);
  });
export class OpenAIEnrollmentKeychainCredentials {
  constructor(
    private readonly run: Run = nativeRun,
    private readonly reader = new KeychainRotationCredentials(),
  ) {}
  async create(operationId: string, value: string, signal: AbortSignal) {
    try {
      const reference = openAIEnrollmentCredentialReference(operationId);
      z.string().min(1).max(16384).parse(value);
      signal.throwIfAborted();
      z.object({ ok: z.literal(true) })
        .strict()
        .parse(
          JSON.parse(
            await this.run(
              JSON.stringify({
                service: reference.service,
                account: reference.account,
                value,
                version: operationId,
              }),
              signal,
            ),
          ),
        );
      return reference;
    } catch {
      throw new Error('OpenAI Keychain creation could not be confirmed');
    }
  }
  read(reference: CredentialReference, signal: AbortSignal) {
    return this.reader.read(reference, signal);
  }
}
