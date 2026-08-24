#!/usr/bin/env bash
# Generates a THROWAWAY CA + PostgreSQL server certificate for the local
# production-shaped stack (docker-compose.prod.yml).
#
# WHY THIS EXISTS: production requires DB_SSL_CA / DB_SSL_CA_CERT and validates
# the PostgreSQL server certificate with rejectUnauthorized:true (ZT-012, see
# src/config/database-ssl.ts). Verifying the real production boot path
# therefore needs a real TLS-serving Postgres — so the local stack gets its own
# disposable CA, rather than the production code path being weakened so it can
# be tested.
#
# The files this writes secure nothing but a local container, carry no trust
# anywhere, and are gitignored. A managed database issues its own CA — use
# that in production, never this.
#
# Usage:  bash deploy/generate-local-tls.sh
set -euo pipefail

# Git Bash on Windows rewrites a leading "/" in -subj into a Windows path, and
# the mingw openssl build cannot resolve MSYS-style /d/... paths. Disabling the
# conversion and cd-ing into the output directory (so every path argument is a
# bare filename) makes this script behave identically on Windows and Linux.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

cd "$(dirname "$0")"
mkdir -p tls
cd tls

# The SAN must cover the compose service name the API connects to ("postgres"),
# plus localhost/127.0.0.1 for a host-side psql.
cat > san.cnf <<'CNF'
subjectAltName = DNS:postgres, DNS:localhost, IP:127.0.0.1
CNF

openssl req -new -x509 -days 825 -nodes \
  -subj "/CN=ziyarati-local-ca" \
  -keyout ca.key -out ca.crt >/dev/null 2>&1

openssl req -new -nodes -subj "/CN=postgres" \
  -keyout server.key -out server.csr >/dev/null 2>&1

openssl x509 -req -days 825 -in server.csr \
  -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -extfile san.cnf >/dev/null 2>&1

rm -f server.csr ca.srl san.cnf
chmod 600 server.key ca.key

echo "Wrote throwaway TLS material to deploy/tls:"
ls -1
