#!/usr/bin/python3 -I
"""Build-only canonicalization of the reviewed sandbox Codex; --check is read-only.

No host device-login CLI, package installation, policy, credentials or gateway is
modified. Only the already-reviewed Linux arm64 sandbox package is supported.
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import stat
import sys

VERSION = '0.159.1'
NATIVE_SHA256 = '22c787768933ff4d97e62e2d4613e1671e18b6a2cc999f0666be544acecffa45'
CODE_MODE_HOST_SHA256 = 'd2f036fd6adc398a1f87a2458c3726558c2eb5660e73dc2b4b4a6b25241c6178'
PACKAGE_SHA256 = 'fa911ae5709786fb391fd8417073683915f8d8dd8527078adfc6da0fb3c0d625'
PACKAGE = Path('/usr/lib/node_modules/@openai/codex')
NATIVE = PACKAGE / 'node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex'
CODE_MODE_HOST = NATIVE.with_name('codex-code-mode-host')
CANONICAL = Path('/usr/bin/codex')
CANONICAL_CODE_MODE_HOST = CANONICAL.with_name('codex-code-mode-host')


def checked_bytes(path, digest, executable=False):
    if path.resolve(strict=True) != path:
        raise ValueError('reviewed native artifact must not be a symlink')
    info = path.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise ValueError('reviewed native artifact must be a root-owned immutable regular file')
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError('reviewed native artifact hash mismatch')
    if executable and (not info.st_mode & 0o111 or data[:6] != b'\x7fELF\x02\x01'
                       or int.from_bytes(data[18:20], 'little') != 183):
        raise ValueError('reviewed native artifact must be an executable Linux arm64 ELF')
    return data


def normalize(install=False):
    if platform.system() != 'Linux' or platform.machine() not in ('aarch64', 'arm64'):
        raise ValueError('only the reviewed Linux arm64 sandbox image is supported')
    package = json.loads(checked_bytes(PACKAGE / 'package.json', PACKAGE_SHA256))
    if package.get('name') != '@openai/codex' or package.get('version') != VERSION:
        raise ValueError('reviewed sandbox Codex version mismatch')
    native = checked_bytes(NATIVE, NATIVE_SHA256, executable=True)
    code_mode_host = checked_bytes(CODE_MODE_HOST, CODE_MODE_HOST_SHA256, executable=True)
    if install:
        if os.geteuid() != 0:
            raise ValueError('canonical installation is an image-build root operation')
        # Replace only the known npm shim, or accept an already normalized image.
        if CANONICAL.is_symlink():
            if CANONICAL.resolve(strict=True) != PACKAGE / 'bin/codex.js':
                raise ValueError('unexpected canonical Codex symlink target')
            temporary = CANONICAL.with_name('.symposium-codex-native')
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o755)
            try:
                os.fchmod(descriptor, 0o755)
                with os.fdopen(descriptor, 'wb') as stream:
                    stream.write(native)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, CANONICAL)
            finally:
                temporary.unlink(missing_ok=True)
        # Codex resolves this packaged helper beside its own executable. Moving
        # only the main ELF to /usr/bin leaves code-mode turns without a host.
        # Refuse an existing unreviewed target, including a symlink.
        if not CANONICAL_CODE_MODE_HOST.exists() and not CANONICAL_CODE_MODE_HOST.is_symlink():
            temporary = CANONICAL_CODE_MODE_HOST.with_name('.symposium-codex-code-mode-host')
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o755)
            try:
                os.fchmod(descriptor, 0o755)
                with os.fdopen(descriptor, 'wb') as stream:
                    stream.write(code_mode_host)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, CANONICAL_CODE_MODE_HOST)
            finally:
                temporary.unlink(missing_ok=True)
    checked_bytes(CANONICAL, NATIVE_SHA256, executable=True)
    checked_bytes(CANONICAL_CODE_MODE_HOST, CODE_MODE_HOST_SHA256, executable=True)
    return {'path': str(CANONICAL), 'source': str(NATIVE), 'version': VERSION,
            'sha256': NATIVE_SHA256, 'codeModeHostPath': str(CANONICAL_CODE_MODE_HOST),
            'codeModeHostSha256': CODE_MODE_HOST_SHA256, 'packageSha256': PACKAGE_SHA256}


if __name__ == '__main__':
    if sys.argv[1:] not in (['--install'], ['--check']):
        raise SystemExit('usage: normalize-symposium-codex.py --install|--check')
    try:
        print(json.dumps(normalize(sys.argv[1] == '--install'), sort_keys=True))
    except (OSError, ValueError) as error:
        raise SystemExit('Canonical sandbox Codex validation failed: ' + str(error))
