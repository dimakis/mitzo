"""Verify an iPhone build actually ships its matching Watch companion."""

import plistlib
import sys
from pathlib import Path


def check_bundle(app: Path) -> None:
    with (app / "Info.plist").open("rb") as source:
        phone = plistlib.load(source)
    watch = app / "Watch" / "MitzoWatch.app"
    if not watch.is_dir():
        raise ValueError("iPhone build is missing Watch/MitzoWatch.app")
    with (watch / "Info.plist").open("rb") as source:
        companion = plistlib.load(source)
    if companion.get("WKCompanionAppBundleIdentifier") != phone["CFBundleIdentifier"]:
        raise ValueError("Watch companion targets a different iPhone app")
    if companion.get("WKApplication") is not True:
        raise ValueError("Embedded companion is not a watchOS app")
    for key in ("CFBundleShortVersionString", "CFBundleVersion"):
        if companion.get(key) != phone[key]:
            raise ValueError(f"Watch and iPhone {key} differ")
    if not (watch / companion["CFBundleExecutable"]).is_file():
        raise ValueError("Watch companion executable is missing")


if __name__ == "__main__":
    try:
        check_bundle(Path(sys.argv[1]))
    except (OSError, ValueError, KeyError, IndexError) as error:
        sys.exit(f"Watch bundle check failed: {error}")
    print("Watch companion is embedded with matching identity and version.")
