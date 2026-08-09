# Restarting the isolated LOCAL perf-audit stack

Containers persist across `docker` daemon restarts (data survives), but the
node processes do not — this repeats each session. Steps, in order:

1. **Docker Desktop must be running.** If `docker info` fails, launch it:
   `Start-Process 'C:\Users\LENOVO\AppData\Local\Programs\DockerDesktop\Docker Desktop.exe'`
   then wait for `docker info` to succeed (can take 30-90s).

2. **Start the containers** (they already exist — never `docker run` a fresh pair, that
   creates duplicates and orphans the data volume):
   `docker start ziyarati-perfaudit-postgres ziyarati-perfaudit-redis`

3. **Verify data survived**:
   `docker exec ziyarati-perfaudit-postgres psql -U postgres -d ziyarati_perf -c "SELECT count(*) FROM tenants;"`
   Expect 50 (T1) or 500 (T2) depending on which tier was last active — check `reports/data-tiers.md`.

4. **Start the API and worker via PowerShell's `Start-Process`** (not bash `nohup ... &` —
   confirmed unreliable for this app in this environment: the process comes up fine but
   Node fully buffers stdout when it's not a TTY, so a `nohup`-redirected log can appear
   empty for 30-40s while the app is genuinely still inside `BootstrapSeeder` — don't kill
   and retry during that window, just wait). Required env, **exported, never written into
   the tracked `.env`**:
   - `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5434/ziyarati_perf`
   - `REDIS_URL=redis://127.0.0.1:6380`
   - `PORT=3001` (API only)
   - `NODE_ENV=development` (production crashes — SSL — see environments.md)
   - `TYPEORM_SYNCHRONIZE=false` (the tracked `.env` has this `true`; must be overridden)

   API: `node dist/src/main` · Worker: `node dist/src/worker` (both from `Ziyarati-back/`,
   both need a fresh `npm run build` first if source changed since the last build).

5. **Confirm readiness**: `curl http://127.0.0.1:3001/api/v1/system/health/readiness`
   → `{"status":"ok","database":{"status":"up"},"redis":{"status":"up",...}}`.
