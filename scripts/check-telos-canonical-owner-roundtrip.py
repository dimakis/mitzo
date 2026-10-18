"""Read synthetic Mitzo-written DB copies through the actual pinned MGMT owner."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
from datetime import datetime
from tempfile import TemporaryDirectory


def main():
    sys.dont_write_bytecode = True
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mgmt-root", type=Path, required=True)
    parser.add_argument("--export-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    owner = args.mgmt_root.resolve()
    data = args.export_root.resolve()
    output = args.output.resolve()
    revision = subprocess.check_output(
        ["git", "-C", str(owner), "rev-parse", "HEAD"], text=True
    ).strip()
    assert revision == "3077b7b4dcdf0ef097062794b2ab93d33c1d89ad"
    manifest = json.loads(
        Path(
            "server/__tests__/fixtures/telos-canonical-3077b7b4/manifest.json"
        ).read_text()
    )
    for name, expected in manifest["owner"]["files"].items():
        current = (owner / name).read_bytes()
        committed = subprocess.check_output(
            ["git", "-C", str(owner), "show", revision + ":" + name]
        )
        assert hashlib.sha256(current).hexdigest() == expected and current == committed

    def row(path, item_id):
        with sqlite3.connect(path) as db:
            db.row_factory = sqlite3.Row
            return dict(
                db.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
            )

    cases = []
    with TemporaryDirectory(prefix="telos-owner-read-fence-") as temporary:
        unused = Path(temporary) / "unused-default.db"
        os.environ["TELOS_DB_PATH"] = str(unused)
        sys.path.insert(0, str(owner / "command_center"))
        from lib.todo.store import TodoStore

        files = sorted(data.glob("*.json"))
        assert len(files) == 4
        for filename in files:
            expected = json.loads(filename.read_text())
            record = expected["record"]
            path = filename.with_suffix(".db")
            before = row(path, record["itemId"])
            assert before == record["legacyFields"]["item"]
            with TodoStore(path) as store:
                item = store.get(record["itemId"])
                assert item is not None and item.id == record["itemId"]
                for name in [
                    "summary",
                    "intent",
                    "rationale",
                    "profile",
                    "priority",
                    "categories",
                ]:
                    assert getattr(item, name) == record[name], name
                assert item.acceptance_criteria == record["acceptanceCriteria"]
                assert item.status.value == record["status"]
                assert item.starred == record["starred"]
                for name in ["first_seen", "last_seen", "created_at", "updated_at"]:
                    assert getattr(item, name) == datetime.fromisoformat(
                        before[name].replace("Z", "+00:00")
                    ), name
                hints = {
                    "repos": "repos",
                    "paths": "paths",
                    "issues": "issues",
                    "doc_ids": "docIds",
                    "people": "people",
                    "jira_keys": "jiraKeys",
                    "keywords": "keywords",
                    "task_hint": "taskHint",
                    "session_ids": "sessionIds",
                }
                for python_name, wire_name in hints.items():
                    assert (
                        getattr(item.context_hints, python_name)
                        == record["contextHints"][wire_name]
                    ), python_name
                assert len(item.sources) == len(record["sources"])
                assert len(item.links) == len(record["links"])
            assert row(path, record["itemId"]) == before
            assert before["parent_id"] == record["parentId"]
            with sqlite3.connect(path) as db:
                history = db.execute(
                    "SELECT old_status,new_status FROM history WHERE item_id=?",
                    (item.id,),
                ).fetchall()
                assert history == [(None, "active")]
                assert db.execute("PRAGMA foreign_key_check").fetchall() == []
            cases.append(
                {
                    "case": filename.stem,
                    "itemId": item.id,
                    "pythonHydration": "pass",
                    "allRawCanonicalFieldsPreserved": True,
                    "timestampsAndHistory": "pass",
                    "priority": item.priority,
                    "categories": item.categories,
                    "firstSeen": item.first_seen.isoformat(),
                    "createdAt": item.created_at.isoformat(),
                }
            )
        assert not unused.exists(), "Canonical owner touched its default database"
    result = {
        "owner": revision,
        "ownerFilesMatchAcceptedManifest": True,
        "syntheticCases": cases,
        "defaultDatabaseUntouched": True,
        "modelOrLiveBackendCalls": 0,
    }
    output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
