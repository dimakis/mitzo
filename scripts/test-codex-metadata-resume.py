#!/usr/bin/env python3
"""Exercise the pinned native resume contract offline, with synthetic history.

No credentials, existing homes, services, model turns or production data are used.
Only initialization, thread resume and metadata inspection are sent to a disposable app-server.
"""

import argparse
import json
import os
from pathlib import Path
import selectors
import subprocess
import tempfile
import time
import uuid


FRAME_LIMIT = 4 * 1024 * 1024
PIN = Path(__file__).resolve().parents[1] / "docs/spikes/openshell-codex/runtime-codex-version"


def probe(binary, version, exclude_turns):
    with tempfile.TemporaryDirectory(prefix="mitzo-native-resume-") as directory:
        root = Path(directory)
        home = root / "home"
        codex_home = home / ".codex"
        sessions = codex_home / "sessions/2026/01/01"
        sessions.mkdir(parents=True)
        thread = str(uuid.uuid4())
        turn = str(uuid.uuid4())
        timestamp = "2026-01-01T00:00:00.000Z"
        records = [
            {
                "type": "session_meta",
                "payload": {
                    "id": thread,
                    "timestamp": timestamp,
                    "cwd": str(root),
                    "originator": "mitzo_offline_resume_fixture",
                    "cli_version": version,
                    "source": "cli",
                    "model_provider": "offline",
                    "history_mode": "paginated",
                },
            },
            {"type": "event_msg", "payload": {
                "type": "task_started", "turn_id": turn, "root_turn_id": turn,
                "started_at": 1767225600000, "model_context_window": 128000,
                "collaboration_mode_kind": "default",
            }},
            *[{
                "type": "event_msg",
                "payload": {
                    "type": "item_completed",
                    "thread_id": thread,
                    "turn_id": turn,
                    "started_at_ms": 1767225600000,
                    "completed_at_ms": 1767225600001,
                    "item": {
                        "type": "DynamicToolCall",
                        "id": f"offline-tool-output-{item}",
                        "tool": "offline_fixture",
                        "arguments": {},
                        "status": "completed",
                        "content_items": [{"type": "inputText", "text": "x" * (FRAME_LIMIT // 2)}],
                        "success": True,
                        "duration": {"secs": 0, "nanos": 0},
                    },
                },
            } for item in range(3)],
            {
                "type": "event_msg",
                "payload": {"type": "task_complete", "turn_id": turn, "last_agent_message": "Done"},
            },
        ]
        rollout = sessions / f"rollout-2026-01-01T00-00-00-{thread}.jsonl"
        with rollout.open("w") as output:
            for ordinal, record in enumerate(records):
                encoded = json.dumps({"timestamp": timestamp, "ordinal": ordinal, **record})
                assert len(encoded.encode()) < FRAME_LIMIT, "An individual fixture event exceeded the live frame bound"
                output.write(encoded + "\n")
        # Do not inherit keys, profiles, accounts, hooks, MCPs, or a real provider.
        environment = {
            "PATH": os.defpath,
            "HOME": str(home),
            "CODEX_HOME": str(codex_home),
            "TMPDIR": str(root),
            "RUST_LOG": "off",
        }
        observed = subprocess.check_output([binary, "--version"], env=environment, text=True, timeout=10)
        if observed.strip() != f"codex-cli {version}":
            raise AssertionError("Offline resume binary does not match the repository runtime pin")
        command = [binary, "app-server", "--listen", "stdio://"]
        for setting in [
            'model_provider="offline"',
            'model="gpt-6-luna"',
            'model_providers.offline.name="Offline fixture: no inference"',
            'model_providers.offline.base_url="http://127.0.0.1:9/v1"',
            'model_providers.offline.wire_api="responses"',
            'model_providers.offline.requires_openai_auth=false',
        ]:
            command.extend(["-c", setting])
        child = subprocess.Popen(
            command, cwd=root, env=environment,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )
        selector = selectors.DefaultSelector()
        selector.register(child.stdout, selectors.EVENT_READ)
        buffer = bytearray()

        def send(message):
            assert message["method"] in {"initialize", "initialized", "thread/resume", "thread/turns/list"}
            child.stdin.write((json.dumps(message) + "\n").encode())
            child.stdin.flush()

        def response(request_id):
            deadline = time.monotonic() + 30
            scan = 0
            while time.monotonic() < deadline:
                for key, _ in selector.select(1):
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        raise AssertionError("Offline native process exited before responding")
                    buffer.extend(chunk)
                    if len(buffer) > 3 * FRAME_LIMIT:
                        raise AssertionError("Synthetic native response exceeded its fixture bound")
                    while True:
                        newline = buffer.find(b"\n", scan)
                        if newline == -1:
                            scan = len(buffer)
                            break
                        frame = json.loads(buffer[:newline])
                        del buffer[:newline + 1]
                        scan = 0
                        if frame.get("id") == request_id:
                            if "error" in frame:
                                # Provider error text is deliberately excluded from test output.
                                raise AssertionError("Offline native resume rejected the synthetic fixture")
                            return frame["result"], newline
            raise AssertionError("Offline native resume timed out")

        try:
            send({"id": 1, "method": "initialize", "params": {
                "clientInfo": {"name": "mitzo_offline_resume_fixture", "version": "1"},
                "capabilities": {"experimentalApi": True},
            }})
            response(1)
            send({"method": "initialized", "params": {}})
            send({"id": 2, "method": "thread/resume", "params": {
                "threadId": thread, "excludeTurns": exclude_turns,
                "cwd": str(root), "model": "gpt-6-luna", "modelProvider": "offline",
            }})
            result, size = response(2)
            assert result["thread"]["id"] == thread, "Native resume changed the retained thread"
            if exclude_turns:
                assert size < FRAME_LIMIT, "Metadata-only resume exceeded the transport bound"
                assert result["thread"]["turns"] == [], "Metadata-only resume hydrated history"
                send({"id": 3, "method": "thread/turns/list", "params": {
                    "threadId": thread, "limit": 1, "itemsView": "notLoaded",
                }})
                retained, _ = response(3)
                assert retained["data"][0]["id"] == turn, "Metadata-only resume lost native history"
                assert retained["data"][0]["status"] == "completed", "Native completion state changed"
            else:
                assert size > FRAME_LIMIT, "Fixture did not reproduce a large retained turn"
                assert result["thread"]["turns"], "Native fixture history was not loaded"
            return size
        finally:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
            selector.close()
            child.stdin.close()
            child.stdout.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex", required=True, type=lambda value: str(Path(value).resolve()))
    args = parser.parse_args()
    pinned = PIN.read_text().strip()
    full = probe(args.codex, pinned, False)
    metadata = probe(args.codex, pinned, True)
    print(json.dumps({"runtime": pinned, "full_history_bytes": full, "metadata_bytes": metadata,
                      "provider_turns_started": 0, "passed": True}))
