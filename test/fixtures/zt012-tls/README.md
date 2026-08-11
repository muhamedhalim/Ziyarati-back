# ZT-012 test TLS fixtures

Isolated, self-generated certificates used **only** by the ZT-012 database-TLS
regression tests (`test/database-tls.e2e-spec.ts`). None of these are real —
they were generated for this test suite and carry no production trust
anywhere. Never use them for anything other than the disposable test
Postgres containers these tests stand up.

- `ca.crt` / `ca.key` — a self-signed test CA (`CN=zt-008-test-ca`).
- `server.crt` / `server.key` — a server certificate for `localhost` /
  `zt-008-pg-ssl` / `127.0.0.1`, signed by the test CA above. Presented by
  the "trusted" disposable Postgres fixture.
- `untrusted.crt` / `untrusted.key` — an unrelated self-signed certificate
  (`CN=totally-not-the-real-db`, matching the audit's own reproduction),
  signed by neither the test CA nor anything else. Presented by the
  "untrusted" disposable Postgres fixture — the app must refuse to connect
  to this one.

Regenerate at any time with:

```bash
openssl req -new -x509 -days 3650 -nodes -subj "/CN=zt-008-test-ca" -keyout ca.key -out ca.crt
openssl req -new -nodes -subj "/CN=localhost" -keyout server.key -out server.csr
openssl x509 -req -days 3650 -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt \
  -extfile <(echo "subjectAltName = DNS:localhost, DNS:zt-008-pg-ssl, IP:127.0.0.1")
openssl req -new -x509 -days 3650 -nodes -subj "/CN=totally-not-the-real-db" -keyout untrusted.key -out untrusted.crt
rm -f server.csr
```
