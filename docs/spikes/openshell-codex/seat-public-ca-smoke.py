"""Fake public data only: prove the actual kernel rules allow exactly CA reads."""
import errno
import os
from pathlib import Path


def denied(operation):
    try:
        operation()
    except OSError as error:
        assert error.errno in (errno.EACCES, errno.EPERM), error
    else:
        raise AssertionError("Landlock unexpectedly allowed an operation")


bundle = Path(os.environ["SSL_CERT_FILE"])
ca = Path(os.environ["NODE_EXTRA_CA_CERTS"])
assert bundle.read_text() == "public-bundle"
assert ca.read_text() == "public-ca"
for path in (bundle, ca):
    denied(lambda: path.write_text("changed"))
    denied(path.unlink)
for path in (
    Path("/run/openshell-supervisor-ca/material/ca.key"),
    Path("/run/unrelated-secret"),
    Path(os.environ["HOME"]) / "escape",
):
    denied(path.read_text)
denied(lambda: list(Path("/run/openshell-supervisor-ca/material").iterdir()))
denied(lambda: Path("/run/openshell-supervisor-ca/material/new-file").write_text("no"))
print("Public CA reads allowed; writes, private key, directory and unrelated reads denied")
