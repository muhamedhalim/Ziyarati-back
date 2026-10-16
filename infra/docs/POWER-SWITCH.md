# Manual power switch: `zt-start` / `zt-stop` / `zt-status`

| | |
|---|---|
| **Added** | 2026-10-16 |
| **Code** | `infra/scripts/zt-power.sh`, test `infra/scripts/tests/zt-power.test.sh` |
| **Scope** | Production, account `270370109141`, `eu-central-1` only (hard-coded; other account/region = refuse) |
| **Verified** | Offline only (70 scenarios, stateful fake `aws`/`curl`; reviewed twice, 2026-10-16). **Not yet run against live AWS**: the authoring machine had no AWS access. First run: `zt-status`, then `zt-stop --dry-run`, `zt-start --dry-run`. |

## Install (CloudShell, once; `$HOME` persists)

```bash
git clone <repo-url> ~/ziyarati && cd ~/ziyarati   # or upload infra/scripts/zt-power.sh via Actions > Upload file
bash Ziyarati-back/infra/scripts/zt-power.sh install
# install prints whether ~/bin is on PATH; if not:
export PATH="$HOME/bin:$PATH" && echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc
zt-status
```

Needs `aws` v2, `jq`, `curl`, `flock` (all in CloudShell). Terraform is **not** required.

## Use

```bash
zt-stop  [--dry-run] [--yes]   # asks you to type 'yes' unless --yes
zt-start [--dry-run]
zt-status                      # read-only
bash zt-power.sh unlock --yes  # remove a DEAD run's lock (see Concurrency)
```

`--dry-run` makes **no** mutating call (no scaling, RDS, state or lock writes) and ends by listing what it did not check: task drain, RDS reaching stopped/available, steady state, Valkey wait, ALB target health, `/health`, readiness.

Every command checks account + region first, uses explicit timeouts, and is safe to repeat.
Timeouts are env-tunable: `ZT_TIMEOUT_ECS`, `_DRAIN`, `_RDS`, `_CACHE`, `_HTTP` (seconds).

## What `zt-stop` does (in order)

1. Verifies account/region, that both ECS services exist, reads RDS state.
2. Saves **restore values** (desired/min/max/task-definition per service) to SSM parameter
   `/ziyaratech/production/power-state` (plain JSON, no secrets, standard tier = free). Written *before* anything changes and never overwritten by a re-run while `stopping`/`stopped`.
3. **API**: autoscaling min/max -> 0/0, desired -> 0, wait until tasks are gone (API first so no new HTTP work/webhooks start).
4. **Worker**: same; ECS sends SIGTERM and waits the task's `stopTimeout` (90 s) for the BullMQ drain. Jobs longer than that are killed and re-queued by BullMQ (stalled-job recovery).
5. **RDS**: `stop-db-instance` **only if Single-AZ** (live state on 2026-10-16: Single-AZ, 14-day retention). Multi-AZ cannot be stopped by AWS and is never altered; the tool leaves it running and says so.
6. Prints status.

**Left alone (still billed):** ALB, NAT gateway + EIP, Valkey (2 × cache.t4g.micro), WAF, RDS storage and automated backups, CloudWatch (logs/alarms/Container Insights), KMS, Secrets Manager, ECR, S3, SES, GuardDuty/CloudTrail/Config, VPC flow logs, public IPv4.
While stopped, the ALB answers 503 on `api.ziyaratech.com`; DNS is untouched.

## What `zt-start` does (in order)

1. Account/region guard; per service: a service that is **running uses its live values**, a parked one (0/0) uses the saved state. Saved state must pass validation (known status, numeric desired/min/max, task definition) or the tool refuses and tells you how to repair it. Parked with no state: it refuses and asks for `ZT_API_RESTORE=2,2,6 ZT_WORKER_RESTORE=1,1,3` (desired,min,max).
2. **Network**: for every API subnet the governing route table is resolved (explicit association, else the VPC **main** table); it needs an *active* `0.0.0.0/0` route. A NAT target must be `available`; a non-NAT active target (e.g. igw) is warned, not rejected; blackhole/missing/no table stops the start (fix via Terraform).
3. **RDS**: start if stopped (waits through `stopping`), wait `available`; warns if backup retention is 0.
4. **Valkey**: must exist and be `available` (it is never removed by this tool; missing = stop with instructions).
5. **Image**: takes the task definition each service *already points at* (stop does not change it), requires status ACTIVE, **refuses `:bootstrap`/untagged** on every container, and confirms existence per registry: private ECR in account `270370109141`/`eu-central-1` via `ecr describe-images` on the image's own repository; `public.ecr.aws` via the anonymous registry API (token + manifest HEAD, read-only); private ECR of another account/region is refused; any other registry is warned as unverifiable (ECS pulls it on start). If the service's revision differs from the one saved at stop (someone deployed meanwhile) it refuses unless `ZT_ACCEPT_TASKDEF_CHANGE=1`. It never registers a task definition.
6. Restores autoscaling min/max, sets desired (worker, then API), waits for a single COMPLETED PRIMARY deployment on the expected revision (catches circuit-breaker rollback).
7. **Verify**: ALB targets healthy (>= desired API count), `GET /api/v1/health` 200, `/api/v1/system/health/readiness` ok/busy (covers DB + Redis wiring). State -> `running`.

## State machine (SSM `/ziyaratech/production/power-state`)

| status | meaning |
|---|---|
| `stopping` | a stop run is in progress (or was killed hard) |
| `stopped` | ECS parked at 0 **and** RDS confirmed `stopped` (or Multi-AZ, recorded as `rds: left-running-multi-az`) |
| `partial` | a run failed after it began changing things (`failedDuring` = start/stop, `failedAt`); written automatically on any failure, Ctrl-C or SIGTERM |
| `starting` | a start run is in progress (or killed hard) |
| `running` | start finished and passed ALB/health/readiness |

The restore snapshot (desired/min/max/task definition per service) is created once from live values and then **never recaptured from a parked (0/0) service**; every transition keeps it. `stopped` is never written unless the shutdown really completed. A foreign state change mid-run aborts without touching it.

## Concurrency

* Same machine: local `flock`.
* Across CloudShell sessions/operators: an SSM lock parameter `/ziyaratech/production/power-lock` is created with put-parameter **without** overwrite, which AWS makes atomic: exactly one creator wins, the other gets `ParameterAlreadyExists` and aborts before any change. It is released on exit (success, failure, Ctrl-C), only if it still carries this run's token.
* Guarantee is mutual exclusion **between runs of this tool** while the lock exists. It never auto-expires (auto-takeover cannot be made race-free without compare-and-swap), so a hard-killed run (CloudShell timeout/SIGKILL) leaves the lock: confirm with `zt-status`, then `bash zt-power.sh unlock --yes`.
* Not covered: someone running raw `aws ecs/rds` commands, Terraform or CI deploys at the same time.

## Terraform consistency

* Terraform ignores `desired_count` and `task_definition` on both services, so those never drift.
* **The only TF-visible change while stopped:** `aws_appautoscaling_target` min/max show `0` instead of `2..6` / `1..3`. `zt-start` restores them exactly.
* **Do not run `terraform apply` while stopped**: it would reset autoscaling to 2..6 / 1..3 and ECS would start tasks against a stopped DB. Run `zt-start` first.
* The SSM state parameter is outside Terraform by design (no new infra module). Delete it with `aws ssm delete-parameter --name /ziyaratech/production/power-state` only if you want to forget a stale state.

## Cost (estimates from the 2026-10-16 live config and the measured rates in `COST.md`; not re-measured)

| Component | While stopped | Approx. $/month if stopped 24x7 |
|---|---|---|
| ECS Fargate API 2 x 0.5 vCPU/1 GB + worker 1 x 0.5/1 | stops billing | **≈ 62 saved** |
| RDS `db.t3.small` Single-AZ compute | stops billing | **≈ 25–30 saved** |
| **Total saved (24x7)** | | **≈ $90**, i.e. ≈ $0.12 per stopped hour |
| RDS storage (50 GB gp3) + backups | continues | ≈ 7 |
| NAT gateway + EIP | continues | ≈ 41 |
| ALB | continues | ≈ 18 |
| Valkey 2 x micro | continues | ≈ 21 |
| WAF, CloudWatch, KMS, Secrets, public IPv4, GuardDuty, flow logs, ... | continues | ≈ 25+ |

So a stopped stack still costs roughly **$110–130/month**, versus about $200–220 running (single NAT, single-AZ RDS). "Zero cost" is false. Check Cost Explorer after the first week.

### Not implemented on purpose (needs your explicit approval and a Terraform change)

* **NAT removal (~$41/mo)**: deleting it by CLI leaves Terraform holding a dead NAT id and blackholed routes; recreating gives a new id and a second NAT on the next apply. Safe only as a Terraform variable (`nat_enabled`) with the route updated first (see the 2026-10-16 NAT incident in `RIGHT-SIZING-2026-10-16.md`).
* **ALB removal (~$18/mo)**: recreating changes the ALB DNS name, so the `api.ziyaratech.com` record must change; breaks the "no DNS changes" rule.
* **Valkey removal (~$21/mo)**: ElastiCache has no stop. Delete+restore loses queued BullMQ jobs/session cache unless snapshotted, and again needs Terraform state handling.

## Things that bite

* **RDS auto-starts after 7 days stopped** (AWS behaviour). `zt-status` warns after 6 days. Run `zt-stop` again (it re-stops it) or `zt-start`.
* Point-in-time restore is unavailable while the instance is stopped; backups/snapshots are kept.
* CloudWatch alarms (ECS running tasks, ALB 5xx/unhealthy hosts) can fire and email `alert_emails` while stopped. The tool does not mute alarms.
* Tap webhooks, WhatsApp/Meta callbacks and email events sent while stopped get 503; rely on the provider's retries and reconcile payments after start (`tap-payments-rollout.md` reconciliation).
* Scheduled sweeps/jobs inside the worker simply do not run while stopped.

## Required IAM (CloudShell user/role)

`sts:GetCallerIdentity`; `ssm:GetParameter,PutParameter` on the state parameter and `ssm:GetParameter,PutParameter,DeleteParameter` on the lock parameter; `ecs:DescribeServices,DescribeTaskDefinition,UpdateService`; `application-autoscaling:DescribeScalableTargets,RegisterScalableTarget`; `rds:DescribeDBInstances,StopDBInstance,StartDBInstance`; `elasticache:DescribeReplicationGroups`; `ec2:DescribeRouteTables,DescribeSubnets,DescribeNatGateways`; `elbv2:DescribeTargetGroups,DescribeTargetHealth,DescribeLoadBalancers`; `ecr:DescribeImages`. Administrator covers it.

## Recovery if something stops halfway

Both commands are idempotent; the first step is always **`zt-status`**.

| Situation | Action |
|---|---|
| `zt-stop` interrupted / timed out / RDS did not stop | State is `partial` (or `stopping` if killed). Re-run `zt-stop --yes`: it resumes with the original restore values and only writes `stopped` once RDS is `stopped`. |
| `zt-start`/`zt-stop` says the lock is held | `zt-status`; if no run is active (dead session): `bash zt-power.sh unlock --yes`, then re-run. |
| State `partial` after a failed start | Fix the cause shown, re-run `zt-start` (resumes), or `zt-stop` to park again. |
| `zt-start` fails at RDS | Wait for `available` in RDS console/events, re-run `zt-start`. ECS is not started until RDS is available. |
| Fails at network check | Fix the route/NAT through Terraform (update the route first, then the NAT), re-run. |
| Fails at image check | A service points at `bootstrap` or a missing image: run the CI deploy for a known-good tag (`DEPLOYMENT.md`), re-run. Never point it at `:bootstrap`. |
| Services not steady / rollback | Read `/ziyaratech/production/{api,worker}` logs, fix, re-run. Last resort by hand: restore autoscaling with `aws application-autoscaling register-scalable-target ... --min-capacity 2 --max-capacity 6` (worker 1/3) and `aws ecs update-service --desired-count`. |
| SSM state lost/corrupt | `ZT_API_RESTORE=2,2,6 ZT_WORKER_RESTORE=1,1,3 zt-start` (values from `terraform.tfvars`). |
| Health/readiness fails after services are up | Check ALB target health, Secrets Manager reachability via NAT, Valkey and RDS SGs; re-run `zt-start` (it re-verifies). |

## Audit 2026-10-16 (offline review; no AWS calls)

Defects found and fixed: corrupt/garbled SSM state crashed obscurely (now validated, refuses before any change); a stale `stopped` state would overwrite live values on the next stop, and an interrupted start/stop mixed states wrongly (now per-service: live wins when running, saved when parked); no protection against a second operator changing the state mid-run (state is re-checked before the final write); RDS in a terminal status waited the full timeout (now fails fast); only the first container image was checked and `:bootstrap@sha256` slipped through (all containers, any bootstrap tag); `register-scalable-target` would have created an autoscaling target if none existed (skipped with a warning); missing `flock`/`date`, or `ZT_ENV` other than production/staging, failed obscurely or pointed at other clusters; `zt-status` printed jammed lines, could crash on a bad date or corrupt state, and did not warn when RDS had auto-started while state said stopped (now does).

## Known limitations

* Not exercised against real AWS yet (see header). The fake used by the test mirrors the CLI calls the script makes, not AWS behaviour such as `stop-db-instance` refusing during a backup (the tool waits for `available` and reports if it times out).
* No in-flight job/payment inspection (no DB/Redis access from CloudShell by design): "drain" = API first, then the worker's 90 s SIGTERM drain.
* Multi-AZ RDS: not stoppable, tool leaves it running (ECS still stops; saving is smaller).
* One environment per run; `ZT_ENV=staging` is untested.
* Concurrency: see the section above; an orphaned lock needs a manual `unlock`.
* Public-image existence checks need outbound internet from CloudShell (it has it); if unreachable, start refuses rather than guessing.
* `wait_until` retries through transient AWS errors; a persistent permission error therefore shows as repeated errors until the timeout rather than failing at once.
* Unknown on real AWS: whether `register-scalable-target` without `--suspended-state` preserves an existing suspended state (Terraform does not set one, so none is expected); exact `stop-db-instance` refusal cases (read replicas, backup window).
* The 7-day RDS auto-start is only detected when you run `zt-status`; there is no scheduler. Check it at least every 6 days while stopped.
