import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { KEYCHAIN_ROTATION_HELPER } from '../keychain-rotation-credentials.js';

// Scope BOTH native queries to this newly created synthetic store. No login-keychain item is used.
const fixture = String.raw`
import ast, ctypes, io, json, sys
spec=json.load(sys.stdin)
tree=ast.parse(spec['program'])
head=ast.Module(body=tree.body[:-1],type_ignores=[])
exec(compile(head,'<native-helper>','exec'))
create=api(S,'SecKeychainCreate',ctypes.c_int32,[ctypes.c_char_p,ctypes.c_uint32,P,ctypes.c_ubyte,P,ctypes.POINTER(P)])
add=api(S,'SecKeychainAddGenericPassword',ctypes.c_int32,[P,ctypes.c_uint32,P,ctypes.c_uint32,P,ctypes.c_uint32,P,ctypes.POINTER(P)])
delete=api(S,'SecKeychainDelete',ctypes.c_int32,[P])
get_list=api(S,'SecKeychainCopySearchList',ctypes.c_int32,[ctypes.POINTER(P)])
get_path=api(S,'SecKeychainGetPath',ctypes.c_int32,[P,ctypes.POINTER(ctypes.c_uint32),P])
def search_paths():
    refs=P()
    if get_list(ctypes.byref(refs)) != 0: raise ValueError('search-list read failed')
    paths=[]
    for index in range(array_count(refs)):
        buffer=ctypes.create_string_buffer(4096); length=ctypes.c_uint32(4096)
        if get_path(array_get(refs,index),ctypes.byref(length),buffer) != 0: raise ValueError('path read failed')
        paths.append(buffer.raw[:length.value])
    return sorted(paths)
before=search_paths()
keychain=P(); password=b'synthetic-store-password'
if create(spec['path'].encode(),len(password),password,False,None,ctypes.byref(keychain)) != 0: raise ValueError('private store creation failed')
try:
    service=spec['service'].encode(); account=b'synthetic'; value=b'TEMP_OLD'
    item=P()
    if add(keychain,len(service),service,len(account),account,len(value),value,ctypes.byref(item)) != 0: raise ValueError('synthetic item creation failed')
    array_create=api(F,'CFArrayCreate',P,[P,P,ctypes.c_long,P])
    scope=array_create(None,(P*1)(keychain.value),1,ctypes.addressof(ctypes.c_byte.in_dll(F,'kCFTypeArrayCallBacks')))
    mutable=api(F,'CFDictionaryCreateMutableCopy',P,[P,ctypes.c_long,P])
    set_value=api(F,'CFDictionarySetValue',None,[P,P,P])
    remove=api(F,'CFDictionaryRemoveValue',None,[P,P])
    original_copy=copy; original_update=update; diagnostics=[]
    def scoped(query):
        result=mutable(None,0,query); set_value(result,const(S,'kSecMatchSearchList'),scope); return result
    def copy(query,result):
        status=original_copy(scoped(query),result); diagnostics.append(('copy',status))
        if status:
            for omitted in [('kSecReturnData',),('kSecReturnPersistentRef',),('kSecReturnData','kSecReturnPersistentRef')]:
                probe=scoped(query)
                for name in omitted: remove(probe,const(S,name))
                found=P(); diagnostics.append((omitted,original_copy(probe,ctypes.byref(found))))
        return status
    def update(query,attributes):
        status=original_update(scoped(query),attributes); diagnostics.append(('update',status)); return status
    def action(payload):
        old_in=sys.stdin; old_out=sys.stdout
        sys.stdin=io.TextIOWrapper(io.BytesIO(json.dumps({'service':spec['service'],'account':'synthetic',**payload}).encode()),encoding='utf8')
        sys.stdout=io.StringIO()
        try:
            exec(compile(ast.Module(body=[tree.body[-1]],type_ignores=[]),'<native-helper>','exec'))
            return json.loads(sys.stdout.getvalue())
        except SystemExit: raise RuntimeError(payload['action']+':'+repr(diagnostics)) from None
        finally: sys.stdin=old_in; sys.stdout=old_out
    first=action({'action':'read'})
    written=action({'action':'write','value':'TEMP_NEW','version':spec['version'],'expectedVersion':None})
    after=action({'action':'read'})
    rewritten=action({'action':'write','value':'TEMP_FINAL','version':spec['version2'],'expectedVersion':spec['version']})
    final=action({'action':'read'})
    nul_rejected=False
    try: action({'action':'read','service':spec['service']+'\x00different'})
    except RuntimeError: nul_rejected=True
finally:
    if delete(keychain) != 0: raise ValueError('private store cleanup failed')
if search_paths() != before: raise ValueError('search-list changed')
print(json.dumps({'first':first,'written':written,'after':after,'rewritten':rewritten,'final':final,'nulRejected':nul_rejected}))
`;

it.skipIf(process.platform !== 'darwin')(
  'reads and atomically replaces a synthetic item in a temporary Keychain',
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'mitzo-private-keychain-'));
    const version = randomUUID(),
      version2 = randomUUID();
    try {
      const result = spawnSync('/usr/bin/python3', ['-I', '-c', fixture], {
        input: JSON.stringify({
          program: KEYCHAIN_ROTATION_HELPER,
          path: join(directory, 'synthetic.keychain-db'),
          service: `com.mitzo.synthetic.${randomUUID()}`,
          version,
          version2,
        }),
        encoding: 'utf8',
        timeout: 20000,
      });
      expect(result.stderr, result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        first: { value: 'TEMP_OLD', version: null, managed: false },
        written: { ok: true },
        after: { value: 'TEMP_NEW', version, managed: true },
        rewritten: { ok: true },
        final: { value: 'TEMP_FINAL', version: version2, managed: true },
        nulRejected: true,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
