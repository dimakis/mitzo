# A credential-free stdio MCP adapter. Host authorization never comes from these files.
import json, os, stat, sys, time, uuid
root = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
def read(name, limit):
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=root)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
            raise ValueError('Unsafe response')
        with os.fdopen(fd, 'rb', closefd=False) as source: return json.loads(source.read(limit + 1))
    finally: os.close(fd)
def send(identifier, result):
    print(json.dumps({'jsonrpc':'2.0', 'id':identifier, 'result':result}), flush=True)
definitions = read('definitions.json', 65536)
for line in sys.stdin.buffer:
    if len(line) > 65536: break
    identifier = None
    try:
        message = json.loads(line)
        identifier = message.get('id')
        method = message.get('method')
        if identifier is None: continue
        if method == 'initialize':
            send(identifier, {'protocolVersion': message.get('params',{}).get('protocolVersion','2024-11-05'), 'capabilities':{'tools':{}}, 'serverInfo':{'name':'mitzo-host-access','version':'1.0.0'}})
        elif method == 'ping': send(identifier, {})
        elif method == 'tools/list':
            send(identifier, {'tools':[{'name':value['name'],'description':value['description'],'inputSchema':value['input_schema']} for value in definitions]})
        elif method == 'tools/call':
            params = message['params']
            if params['name'] not in [value['name'] for value in definitions]: raise ValueError('Tool unavailable')
            call = str(uuid.uuid4())
            request = json.dumps({'name':params['name'], 'arguments':params.get('arguments',{})}).encode()
            if len(request) > 32768: raise ValueError('Request too large')
            fd = os.open(call+'.tmp', os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600, dir_fd=root)
            try:
                with os.fdopen(fd,'wb',closefd=False) as output: output.write(request)
            finally: os.close(fd)
            os.rename(call+'.tmp', call+'.request', src_dir_fd=root, dst_dir_fd=root)
            deadline = time.monotonic()+330
            while True:
                try: response=read(call+'.response',1024*1024); break
                except FileNotFoundError:
                    if time.monotonic() > deadline: raise ValueError('Host timeout')
                    time.sleep(0.05)
            os.unlink(call+'.response', dir_fd=root)
            send(identifier, {'content':[{'type':'text','text':response['content']}], 'isError':response.get('isError',False)})
        else:
            print(json.dumps({'jsonrpc':'2.0','id':identifier,'error':{'code':-32601,'message':'Method unavailable'}}),flush=True)
    except Exception:
        if identifier is not None:
            send(identifier, {'content':[{'type':'text','text':'Host access request unavailable'}], 'isError':True})
os.close(root)
