import { execFile } from 'node:child_process';
import { z } from 'zod';
import { CredentialReferenceSchema, type CredentialReference } from './credentials.js';
import type { VersionedKeychain } from './openai-key-management.js';

/** The native API updates an existing item's secret and recovery marker together, preserving ACLs.
 * Neither security's password argv nor a temporary credential file is used. */
export const KEYCHAIN_ROTATION_HELPER = String.raw`
import ctypes, hashlib, hmac, json, sys, uuid
F = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
S = ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')
P = ctypes.c_void_p
def api(lib, name, result, args):
    fn = getattr(lib, name); fn.restype = result; fn.argtypes = args; return fn
def const(lib, name): return P.in_dll(lib, name).value
string = api(F, 'CFStringCreateWithCString', P, [P, ctypes.c_char_p, ctypes.c_uint32])
data = api(F, 'CFDataCreate', P, [P, P, ctypes.c_long])
dict_create = api(F, 'CFDictionaryCreate', P, [P, P, P, ctypes.c_long, P, P])
dict_get = api(F, 'CFDictionaryGetValue', P, [P, P])
array_count = api(F, 'CFArrayGetCount', ctypes.c_long, [P])
array_get = api(F, 'CFArrayGetValueAtIndex', P, [P, ctypes.c_long])
data_length = api(F, 'CFDataGetLength', ctypes.c_long, [P])
data_bytes = api(F, 'CFDataGetBytePtr', P, [P])
copy = api(S, 'SecItemCopyMatching', ctypes.c_int32, [P, ctypes.POINTER(P)])
update = api(S, 'SecItemUpdate', ctypes.c_int32, [P, P])
def dictionary(values):
    keys = (P * len(values))(*values.keys()); vals = (P * len(values))(*values.values())
    return dict_create(None, keys, vals, len(values),
        ctypes.addressof(ctypes.c_byte.in_dll(F, 'kCFTypeDictionaryKeyCallBacks')),
        ctypes.addressof(ctypes.c_byte.in_dll(F, 'kCFTypeDictionaryValueCallBacks')))
def bytes_ref(value):
    buffer = ctypes.create_string_buffer(value); return data(None, buffer, len(value))
def get_bytes(value):
    if not value: return b''
    size = data_length(value)
    if size < 0 or size > 65536: raise ValueError()
    return ctypes.string_at(data_bytes(value), size)
def marker_version(marker, value):
    if not marker: return None
    prefix = b'mitzo-openai-key-v1:'
    if not marker.startswith(prefix): raise ValueError()
    version, fingerprint = marker[len(prefix):].decode('ascii').split(':')
    if str(uuid.UUID(version)) != version or len(fingerprint) != 64: raise ValueError()
    return version if hmac.compare_digest(fingerprint,hashlib.sha256(value).hexdigest()) else None
try:
    request = json.loads(sys.stdin.buffer.read(65537))
    for key in ['service', 'account']:
        if not isinstance(request.get(key), str) or not 0 < len(request[key]) <= 256: raise ValueError()
    query = dictionary({
        const(S,'kSecClass'): const(S,'kSecClassGenericPassword'),
        const(S,'kSecAttrService'): string(None,request['service'].encode(),0x08000100),
        const(S,'kSecAttrAccount'): string(None,request['account'].encode(),0x08000100),
        const(S,'kSecMatchLimit'): const(S,'kSecMatchLimitAll'),
        const(S,'kSecReturnAttributes'): const(F,'kCFBooleanTrue'),
        const(S,'kSecReturnData'): const(F,'kCFBooleanTrue'),
        const(S,'kSecReturnPersistentRef'): const(F,'kCFBooleanTrue')})
    result = P()
    if copy(query,ctypes.byref(result)) != 0 or array_count(result) != 1: raise ValueError()
    item = array_get(result,0)
    existing_value = get_bytes(dict_get(item,const(S,'kSecValueData')))
    marker = get_bytes(dict_get(item,const(S,'kSecAttrGeneric')))
    prefix = b'mitzo-openai-key-v1:'
    version = marker_version(marker,existing_value)
    if request['action'] == 'read':
        value = existing_value.decode('utf8')
        if not value or len(value) > 16384: raise ValueError()
        print(json.dumps({'value':value,'version':version}))
    elif request['action'] == 'write':
        if request['expectedVersion'] != version: raise ValueError()
        value = request['value']; version = request['version']
        if not isinstance(value,str) or not 0 < len(value) <= 16384 or str(uuid.UUID(version)) != version: raise ValueError()
        persistent_ref = dict_get(item,const(S,'kSecValuePersistentRef'))
        if not persistent_ref: raise ValueError()
        target_fields = {const(S,'kSecValuePersistentRef'):persistent_ref}
        if marker: target_fields[const(S,'kSecAttrGeneric')] = bytes_ref(marker)
        target = dictionary(target_fields)
        attributes = dictionary({const(S,'kSecValueData'):bytes_ref(value.encode()),
            const(S,'kSecAttrGeneric'):bytes_ref(prefix + version.encode('ascii') + b':' + hashlib.sha256(value.encode()).hexdigest().encode('ascii'))})
        if update(target,attributes) != 0: raise ValueError()
        print('{"ok":true}')
    else: raise ValueError()
except Exception:
    print('{"error":"KEYCHAIN_UNAVAILABLE"}')
    sys.exit(1)
`;
type Run = (stdin: string, signal: AbortSignal) => Promise<string>;
const nativeRun: Run = (stdin, signal) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      '/usr/bin/python3',
      ['-I', '-c', KEYCHAIN_ROTATION_HELPER],
      {
        env: { PATH: '/usr/bin:/bin' },
        signal,
        timeout: 15000,
        maxBuffer: 65536,
      },
      (error, stdout) => {
        if (error) reject(new Error('Keychain unavailable'));
        else resolve(stdout);
      },
    );
    child.stdin?.on('error', () => reject(new Error('Keychain unavailable')));
    child.stdin?.end(stdin);
  });
const Secret = z
  .object({ value: z.string().min(1).max(16384), version: z.uuid().nullable() })
  .strict();
export class KeychainRotationCredentials implements VersionedKeychain {
  constructor(private readonly run: Run = nativeRun) {}
  private async request(
    reference: CredentialReference,
    action: 'read' | 'write',
    signal: AbortSignal,
    extra: Record<string, string | null> = {},
  ) {
    try {
      const ref = CredentialReferenceSchema.parse(reference);
      if (ref.provider !== 'keychain') throw new Error();
      return JSON.parse(
        await this.run(
          JSON.stringify({ action, service: ref.service, account: ref.account, ...extra }),
          signal,
        ),
      ) as unknown;
    } catch {
      throw new Error('Keychain unavailable');
    }
  }
  async read(reference: CredentialReference, signal: AbortSignal) {
    try {
      return Secret.parse(await this.request(reference, 'read', signal));
    } catch {
      throw new Error('Keychain unavailable');
    }
  }
  async write(
    reference: CredentialReference,
    value: string,
    version: string,
    signal: AbortSignal,
    expectedVersion: string | null = null,
  ) {
    try {
      Secret.parse({ value, version });
      z.object({ ok: z.literal(true) })
        .strict()
        .parse(await this.request(reference, 'write', signal, { value, version, expectedVersion }));
    } catch {
      throw new Error('Keychain unavailable');
    }
  }
}
