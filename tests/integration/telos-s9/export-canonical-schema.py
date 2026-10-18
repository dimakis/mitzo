"""Export an empty schema from the real MGMT owner, never from user data.

Usage: python3 tests/integration/telos-s9/export-canonical-schema.py MGMT_CHECKOUT
Review the resulting SQL and source hashes before accepting a changed baseline.
This exports fresh initialization plus migrations; it does not qualify upgrades.
"""

import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True
root = Path(sys.argv[1]).resolve(strict=True)
sys.path.insert(0, str(root / "command_center"))
from lib.todo.store import TodoStore  # noqa: E402

output = Path(__file__).resolve().parent / "fixtures"
with tempfile.TemporaryDirectory(prefix="telos-s9-empty-schema-") as temporary:
    store = TodoStore(Path(temporary) / "empty.db")
    try:
        schema = "\n".join(
            row[0] + ";"
            for row in store._conn.execute(
                "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL "
                "AND name NOT LIKE 'sqlite_%' ORDER BY type DESC,name"
            )
        ) + "\n"
    finally:
        store._conn.close()

files = ["command_center/lib/todo/store.py", "command_center/lib/todo/models.py"]
commit = subprocess.check_output(
    ["git", "-C", str(root), "rev-parse", "HEAD"], text=True
).strip()
hashes = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in files}
for name in files:
    committed = subprocess.check_output(["git", "-C", str(root), "show", f"{commit}:{name}"])
    if hashlib.sha256(committed).hexdigest() != hashes[name]:
        raise ValueError(f"{name} differs from its recorded commit; use a clean accepted checkout")
metadata = {
    "repository": "dimakis/mgmt",
    "commit": commit,
    "sourceFilesMatchCommit": True,
    "generation": "Actual TodoStore fresh initialization and _migrate(), empty disposable database. No user rows. Not a fixture-only schema patch or migration acceptance.",
    "files": hashes,
    "schemaSha256": hashlib.sha256(schema.encode()).hexdigest(),
}
(output / "canonical-schema.sql").write_text(schema)
(output / "canonical-schema-source.json").write_text(json.dumps(metadata, indent=2) + "\n")
