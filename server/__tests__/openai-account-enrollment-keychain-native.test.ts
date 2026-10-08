import { expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { CREATE_OPENAI_ENROLLMENT_KEYCHAIN_HELPER } from '../openai-account-enrollment-keychain.js';
import { KEYCHAIN_ROTATION_HELPER } from '../keychain-rotation-credentials.js';

// Execute the exported native programs, intercepting their Security APIs only to
// scope creation and both read queries to a brand-new synthetic Keychain.
const fixture = String.raw`
import ast, ctypes, io, json, sys
spec=json.load(sys.stdin)
create_tree=ast.parse(spec['createProgram']); read_tree=ast.parse(spec['readProgram'])
for tree in [create_tree,read_tree]:
    exec(compile(ast.Module(body=tree.body[:-1],type_ignores=[]),'<native-helper>','exec'))
create_store=api(S,'SecKeychainCreate',ctypes.c_int32,[ctypes.c_char_p,ctypes.c_uint32,P,ctypes.c_ubyte,P,ctypes.POINTER(P)])
delete_store=api(S,'SecKeychainDelete',ctypes.c_int32,[P])
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
before=search_paths(); keychain=P(); password=b'synthetic-only-password'
if create_store(spec['path'].encode(),len(password),password,False,None,ctypes.byref(keychain)) != 0: raise ValueError('private store creation failed')
try:
    array_create=api(F,'CFArrayCreate',P,[P,P,ctypes.c_long,P])
    scope=array_create(None,(P*1)(keychain.value),1,ctypes.addressof(ctypes.c_byte.in_dll(F,'kCFTypeArrayCallBacks')))
    mutable=api(F,'CFDictionaryCreateMutableCopy',P,[P,ctypes.c_long,P])
    set_value=api(F,'CFDictionarySetValue',None,[P,P,P])
    original_add=add; original_copy=copy
    def add(attributes,result):
        scoped=mutable(None,0,attributes); set_value(scoped,const(S,'kSecUseKeychain'),keychain.value)
        return original_add(scoped,result)
    def copy(query,result):
        scoped=mutable(None,0,query); set_value(scoped,const(S,'kSecMatchSearchList'),scope)
        return original_copy(scoped,result)
    def action(tree,payload):
        old_in=sys.stdin; old_out=sys.stdout
        sys.stdin=io.TextIOWrapper(io.BytesIO(json.dumps(payload).encode()),encoding='utf8'); sys.stdout=io.StringIO()
        try:
            try: exec(compile(ast.Module(body=[tree.body[-1]],type_ignores=[]),'<native-helper>','exec'))
            except SystemExit: pass
            return json.loads(sys.stdout.getvalue())
        finally: sys.stdin=old_in; sys.stdout=old_out
    base={'service':'mitzo.openai.enrollment.'+spec['version'],'account':'api-key'}
    created=action(create_tree,{**base,'value':'SYNTHETIC_KEY','version':spec['version']})
    first=action(read_tree,{**base,'action':'read'})
    duplicate=action(create_tree,{**base,'value':'SYNTHETIC_REPLACEMENT','version':spec['version']})
    final=action(read_tree,{**base,'action':'read'})
finally:
    if delete_store(keychain) != 0: raise ValueError('private store cleanup failed')
if search_paths() != before: raise ValueError('search-list changed')
print(json.dumps({'created':created,'first':first,'duplicate':duplicate,'final':final,'searchListUnchanged':True}))
`;

it.skipIf(process.platform !== 'darwin')(
  'creates a marked synthetic Keychain item and refuses duplicate creation without changing it',
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'mitzo-enrollment-keychain-'));
    const version = randomUUID();
    try {
      const result = spawnSync('/usr/bin/python3', ['-I', '-c', fixture], {
        input: JSON.stringify({
          createProgram: CREATE_OPENAI_ENROLLMENT_KEYCHAIN_HELPER,
          readProgram: KEYCHAIN_ROTATION_HELPER,
          path: join(directory, 'synthetic.keychain-db'),
          version,
        }),
        encoding: 'utf8',
        timeout: 20000,
      });
      expect(result.stderr, result.stderr).toBe('');
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        created: { ok: true },
        first: { value: 'SYNTHETIC_KEY', version, managed: true },
        duplicate: { error: 'KEYCHAIN_CREATION_UNCONFIRMED' },
        final: { value: 'SYNTHETIC_KEY', version, managed: true },
        searchListUnchanged: true,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
