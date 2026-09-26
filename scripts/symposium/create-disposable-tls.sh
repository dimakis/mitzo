#!/bin/sh
# Offline issuance only. Refuse an existing destination; never rotate a live host.
set -eu
umask 077
if [ "$#" -ne 1 ]; then
  echo 'Usage: create-disposable-tls.sh /absolute/new-private-tls-directory' >&2
  exit 2
fi
case "$1" in /*) ;; *) echo 'An absolute new directory is required' >&2; exit 2;; esac
mkdir -m 700 "$1"
cd "$1"
openssl req -x509 -newkey rsa:3072 -nodes -days 7 -subj '/CN=Disposable Symposium CA' \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -keyout ca.key -out ca.crt >/dev/null 2>&1
openssl req -new -newkey rsa:3072 -nodes -subj '/CN=host.containers.internal' \
  -keyout server.key -out server.csr >/dev/null 2>&1
cat > server.ext <<'EXT'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,DNS:host.containers.internal,IP:127.0.0.1
EXT
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 7 -extfile server.ext -out server.crt >/dev/null 2>&1
openssl req -new -newkey rsa:3072 -nodes -subj '/CN=Disposable Symposium Management' \
  -keyout management.key -out management.csr >/dev/null 2>&1
cat > management.ext <<'EXT'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=clientAuth
EXT
openssl x509 -req -in management.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 7 -extfile management.ext -out management.crt >/dev/null 2>&1
openssl verify -CAfile ca.crt -purpose sslserver -verify_hostname host.containers.internal server.crt >/dev/null
openssl verify -CAfile ca.crt -purpose sslserver -verify_ip 127.0.0.1 server.crt >/dev/null
openssl verify -CAfile ca.crt -purpose sslclient management.crt >/dev/null
rm server.csr management.csr server.ext management.ext ca.srl
printf '%s\n' 'Fresh disposable TLS material created and endpoint names verified; no gateway started.'
