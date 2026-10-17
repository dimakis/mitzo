"""Generate schema-only fixtures by executing the accepted canonical owner.

Uses synthetic temporary databases only. Pass an isolated MGMT checkout pinned
to the desired accepted revision; no default database or user rows are read.
"""

import argparse
import ast
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mgmt-root", required=True, type=Path)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--legacy-revision", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    root = args.mgmt_root.resolve()
    owner_paths = [
        "command_center/lib/todo/store.py",
        "command_center/lib/todo/models.py",
        "command_center/todo_api.py",
    ]
    revision = git(root, "rev-parse", args.revision)
    if git(root, "rev-parse", "HEAD") != revision:
        raise SystemExit("MGMT checkout must be pinned to the requested accepted revision")
    if git(root, "status", "--porcelain", "--", *owner_paths):
        raise SystemExit("Canonical owner files have local changes")
    legacy_revision = git(root, "rev-parse", args.legacy_revision)
    legacy_bytes = subprocess.check_output([
        "git", "-C", str(root), "show", f"{legacy_revision}:{owner_paths[0]}"
    ])
    tree = ast.parse(legacy_bytes)
    legacy_schema = next(
        ast.literal_eval(node.value)
        for node in tree.body
        if isinstance(node, ast.Assign)
        and any(isinstance(name, ast.Name) and name.id == "_SCHEMA" for name in node.targets)
    )
    # Explicit paths prevent the owner's worktree-aware default from accessing Telos.
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(root / "command_center"))
    from lib.todo.store import TodoStore

    args.output.mkdir(parents=True, exist_ok=True)
    manifest = {
        "version": 1,
        "owner": {
            "repository": "dimakis/mgmt", "revision": revision,
            "files": {path: digest((root / path).read_bytes()) for path in owner_paths},
        },
        "legacy": {"revision": legacy_revision, "storeSha256": digest(legacy_bytes)},
        "schemas": {},
    }
    stamp = "2026-10-16T10:00:00"
    with TemporaryDirectory(prefix="telos-canonical-owner-") as temporary:
        for variant in ["fresh", "upgraded"]:
            path = Path(temporary) / f"{variant}.db"
            if variant == "upgraded":
                with sqlite3.connect(path) as db:
                    db.executescript(legacy_schema)
                    db.execute("""INSERT INTO items
                        (id,summary,profile,starred,first_seen,last_seen,created_at,updated_at)
                        VALUES('synthetic-parent','Home studio','manual',1,?,?,?,?)""",
                        (stamp, stamp, stamp, stamp))
                    db.execute("""INSERT INTO history(item_id,old_status,new_status,changed_at)
                        VALUES('synthetic-parent',NULL,'active',?)""", (stamp,))
            with TodoStore(path) as store:
                if variant == "upgraded":
                    item = store.get("synthetic-parent")
                    assert item is not None
                    assert item.summary == "Home studio"
                    assert item.priority == 10
                    assert item.first_seen.isoformat() == stamp
                    assert item.created_at.isoformat() == stamp
            with sqlite3.connect(path) as db:
                if variant == "upgraded":
                    history = db.execute("""SELECT old_status,new_status,changed_at FROM history
                        WHERE item_id='synthetic-parent'""").fetchall()
                    assert history == [(None, "active", stamp)]
                    manifest["upgrade"] = {
                        "priority": item.priority,
                        "firstSeenPreserved": True,
                        "historyPreserved": True,
                    }
                # DDL only, including owner indexes/checks/FKs. No user or seed rows.
                statements = db.execute("""SELECT sql FROM sqlite_master
                    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
                    ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,name""").fetchall()
                schema = "\n\n".join(row[0] + ";" for row in statements) + "\n"
                (args.output / f"{variant}.sql").write_text(schema)
                manifest["schemas"][variant] = digest(schema.encode())
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
