"""Export a synthetic backup from the actual canonical owner; never open the live DB."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--mgmt-root', required=True, type=Path)
args = parser.parse_args()
root = args.mgmt_root.resolve()
sys.dont_write_bytecode = True
with tempfile.TemporaryDirectory(prefix='canonical-artifact-fixture-') as tmp:
    db_path = Path(tmp) / 'synthetic.db'
    os.environ['TELOS_DB_PATH'] = str(db_path)
    sys.path.insert(0, str(root / 'command_center'))
    from lib.todo.store import TodoStore
    from lib.todo.models import TodoItem
    owner = TodoStore(db_path)
    item = TodoItem(summary='Synthetic forwarding artifact', profile='manual', sources=[], intent='Test exact retained versions')
    owner.create_outcome(item, [], idempotency_key='synthetic-forwarding-artifact-fixture')
    owner._conn.close()
    with sqlite3.connect(db_path) as conn:
        sql = '\n'.join(conn.iterdump()) + '\n'
    target = Path('server/__tests__/fixtures/canonical-artifact-owner.sql')
    target.write_text(sql)
    receipt = {
        'owner': 'MGMT command_center/lib/todo/store.py TodoStore/create_outcome',
        'ownerHead': subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip(),
        'ownerSourceSha256': hashlib.sha256((root/'command_center/lib/todo/store.py').read_bytes()).hexdigest(),
        'snapshotSha256': hashlib.sha256(sql.encode()).hexdigest(),
        'itemId': item.id,
        'syntheticOnly': True,
        'migrationBoundary': 'Canonical owner initial schema + current supported migrations, prior to TelosArtifactStore initialization',
    }
    Path('server/__tests__/fixtures/canonical-artifact-owner.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(receipt))
