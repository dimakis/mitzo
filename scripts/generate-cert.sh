#!/usr/bin/env bash
# Generate a self-signed TLS certificate with SAN for local HTTPS.
# Usage: ./scripts/generate-cert.sh <hostname>

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <hostname>"
  echo "Example: $0 my-machine.tailnet.ts.net"
  exit 1
fi

HOSTNAME="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
CERT_DIR="$REPO_ROOT/certs"

mkdir -p "$CERT_DIR"

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$CERT_DIR/key.pem" \
  -out "$CERT_DIR/cert.pem" \
  -days 365 \
  -subj "/CN=$HOSTNAME" \
  -addext "subjectAltName=DNS:$HOSTNAME,DNS:localhost,IP:127.0.0.1"

echo ""
echo "Certificate generated:"
echo "  cert: $CERT_DIR/cert.pem"
echo "  key:  $CERT_DIR/key.pem"
echo "  hostname: $HOSTNAME"
echo "  valid for: 365 days"
