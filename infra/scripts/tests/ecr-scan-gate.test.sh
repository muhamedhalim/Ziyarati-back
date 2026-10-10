#!/usr/bin/env bash
# Offline test for infra/scripts/ecr-scan-gate.sh and its wiring in ecs-deploy.sh — a fake `aws`
# replays a scripted sequence of ECR answers, so it needs no AWS account. Run:
#   bash infra/scripts/tests/ecr-scan-gate.test.sh
# CI: executed by .github/workflows/terraform.yml (static job) so the gate itself cannot rot.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE="$HERE/../ecr-scan-gate.sh"
DEPLOY="$HERE/../ecs-deploy.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

DIGEST="sha256:$(printf 'a%.0s' {1..64})"
OTHER="sha256:$(printf 'b%.0s' {1..64})"
TAG=cccccccccccccccccccccccccccccccccccccccc

# Fake aws. FAKE_SEQ is a file of scripted answers for `ecr describe-image-scan-findings`, one per call
# (the last line repeats). Line formats (tab separated):
#   OK  <status> <critical|None> <description>     success, printed like the real --query/--output text
#   ERR <ErrorCode> <message>                      "An error occurred (<ErrorCode>) ..." on stderr, exit 254
#   NET                                            no AWS error code at all (connection problem), exit 255
mkdir -p "$TMP/bin"
cat > "$TMP/bin/aws" <<'EOF'
#!/usr/bin/env bash
args="$*"
case "$args" in
  *"ecr describe-image-scan-findings"*)
    echo "$args" >> "$FAKE_LOG"
    n=$(( $(cat "$FAKE_COUNT" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$FAKE_COUNT"
    total=$(wc -l < "$FAKE_SEQ"); [ "$n" -gt "$total" ] && n="$total"
    line="$(sed -n "${n}p" "$FAKE_SEQ")"
    IFS=$'\t' read -r kind a b c <<<"$line"
    case "$kind" in
      OK)  printf '%s\t%s\t%s\n' "$a" "$b" "$c" ;;
      ERR) echo "An error occurred ($a) when calling the DescribeImageScanFindings operation: $b" >&2; exit 254 ;;
      NET) echo "Could not connect to the endpoint URL" >&2; exit 255 ;;
    esac ;;
  *"sts get-caller-identity"*) echo 111122223333 ;;
  *"ecr describe-images"*)     echo "$FAKE_ECR_DIGEST" ;;
  *) echo "fake aws: unhandled: $args" >&2; exit 99 ;;
esac
EOF
chmod +x "$TMP/bin/aws"

pass=0; failn=0
# gate <name> <expect-exit> <must-contain> <mode> <expected-poll-count|-> <<<scripted lines
gate() {
  local name="$1" want="$2" needle="$3" mode="$4" polls="$5"
  cat > "$TMP/seq"
  : > "$TMP/log"; rm -f "$TMP/count"
  out="$(PATH="$TMP/bin:$PATH" FAKE_SEQ="$TMP/seq" FAKE_LOG="$TMP/log" FAKE_COUNT="$TMP/count" \
    ECR_SCAN_POLL_INTERVAL=0 ECR_SCAN_MAX_INTERVAL=0 ECR_SCAN_TIMEOUT_SECONDS="${TIMEOUT:-60}" \
    ECR_SCAN_MAX_CONSECUTIVE_ERRORS=3 bash "$GATE" "$DIGEST" "$mode" 2>&1)"; rc=$?
  local made; made="$(cat "$TMP/count" 2>/dev/null || echo 0)"
  local ok=1
  [ "$rc" = "$want" ] || ok=0
  [[ "$out" == *"$needle"* ]] || ok=0
  [[ "$out" == *unhandled* ]] && ok=0
  if [ "$polls" != "-" ] && [ "$made" != "$polls" ]; then ok=0; fi
  if [ "$ok" = 1 ]; then pass=$((pass+1)); echo "ok   - $name"
  else failn=$((failn+1)); echo "FAIL - $name (exit $rc, wanted $want; polls $made, wanted $polls; needle '$needle')"; sed 's/^/       /' <<<"$out"; fi
}
T=$'\t'

# ── the reported incident: a delayed scan ────────────────────────────────────
gate "delayed scan: IN_PROGRESS x3 then COMPLETE (0 critical) passes"  0 "no CRITICAL findings" enforce 4 <<EOF
OK${T}IN_PROGRESS${T}None${T}None
OK${T}IN_PROGRESS${T}None${T}None
OK${T}IN_PROGRESS${T}None${T}None
OK${T}COMPLETE${T}None${T}None
EOF
gate "scan not registered yet (ScanNotFoundException) then COMPLETE passes" 0 "no CRITICAL findings" enforce 3 <<EOF
ERR${T}ScanNotFoundException${T}scan not found
ERR${T}ScanNotFoundException${T}scan not found
OK${T}COMPLETE${T}None${T}None
EOF
gate "PENDING then ACTIVE (enhanced scanning) passes"                  0 "no CRITICAL findings" enforce 2 <<EOF
OK${T}PENDING${T}None${T}None
OK${T}ACTIVE${T}None${T}None
EOF

# ── policy: findings are evaluated only on a completed scan ──────────────────
gate "COMPLETE with CRITICAL findings blocks (enforce)"                1 "2 CRITICAL" enforce 1 <<EOF
OK${T}COMPLETE${T}2${T}None
EOF
gate "COMPLETE with CRITICAL findings only warns (warn)"               0 "deploying despite 2 CRITICAL" warn 1 <<EOF
OK${T}COMPLETE${T}2${T}None
EOF
gate "IN_PROGRESS never evaluates findings even if a count is present" 0 "no CRITICAL findings" enforce 2 <<EOF
OK${T}IN_PROGRESS${T}9${T}None
OK${T}COMPLETE${T}None${T}None
EOF
gate "unreadable CRITICAL count on COMPLETE fails closed"              1 "unreadable" enforce 1 <<EOF
OK${T}COMPLETE${T}garbage${T}None
EOF
gate "gate=skip does not call ECR at all (rollback)"                   0 "gate=skip" skip 0 <<EOF
OK${T}COMPLETE${T}5${T}None
EOF

# ── genuine scan failures are reported accurately, not as timeouts ───────────
gate "scan FAILED reports ECR's description (enforce)"                 1 "scan FAILED: could not pull layer" enforce 1 <<EOF
OK${T}FAILED${T}None${T}could not pull layer
EOF
gate "scan FAILED continues under gate=warn"                           0 "WITHOUT a vulnerability verdict" warn 1 <<EOF
OK${T}FAILED${T}None${T}boom
EOF
gate "UNSUPPORTED_IMAGE is reported as unsupported, not as a timeout"  1 "UNSUPPORTED_IMAGE" enforce 1 <<EOF
OK${T}UNSUPPORTED_IMAGE${T}None${T}The operating system is not supported
EOF
gate "FINDINGS_UNAVAILABLE fails closed"                               1 "FINDINGS_UNAVAILABLE" enforce 1 <<EOF
OK${T}FINDINGS_UNAVAILABLE${T}None${T}None
EOF
gate "unknown status fails closed"                                     1 "unrecognised scan status 'WEIRD'" enforce 1 <<EOF
OK${T}WEIRD${T}None${T}None
EOF

# ── API errors: terminal ones surface immediately, transient ones are retried ─
gate "AccessDeniedException is terminal and shown verbatim"            1 "AccessDeniedException" enforce 1 <<EOF
ERR${T}AccessDeniedException${T}not authorized to perform ecr:DescribeImageScanFindings
EOF
gate "ImageNotFoundException is terminal"                              1 "ImageNotFoundException" enforce 1 <<EOF
ERR${T}ImageNotFoundException${T}image not found
EOF
gate "throttling twice then COMPLETE passes (transient retried)"       0 "no CRITICAL findings" enforce 3 <<EOF
ERR${T}ThrottlingException${T}Rate exceeded
ERR${T}ThrottlingException${T}Rate exceeded
OK${T}COMPLETE${T}None${T}None
EOF
gate "network blip then COMPLETE passes"                               0 "no CRITICAL findings" enforce 2 <<EOF
NET
OK${T}COMPLETE${T}None${T}None
EOF
gate "persistent throttling gives up after the error budget"           1 "unreachable after 3 consecutive errors" enforce 3 <<EOF
ERR${T}ThrottlingException${T}Rate exceeded
EOF
gate "errors reset the budget when a poll succeeds in between"         0 "no CRITICAL findings" enforce 6 <<EOF
ERR${T}ThrottlingException${T}Rate exceeded
ERR${T}ThrottlingException${T}Rate exceeded
OK${T}IN_PROGRESS${T}None${T}None
ERR${T}ThrottlingException${T}Rate exceeded
ERR${T}ThrottlingException${T}Rate exceeded
OK${T}COMPLETE${T}None${T}None
EOF

# ── timeout: bounded, explicit, and per policy ───────────────────────────────
TIMEOUT=0 gate "scan stuck IN_PROGRESS past the deadline fails (enforce)" 1 "still IN_PROGRESS after 0s" enforce 1 <<EOF
OK${T}IN_PROGRESS${T}None${T}None
EOF
TIMEOUT=0 gate "timeout under gate=warn continues with a warning"        0 "WITHOUT a vulnerability verdict" warn 1 <<EOF
OK${T}IN_PROGRESS${T}None${T}None
EOF
TIMEOUT=0 gate "scan never registered past the deadline fails (enforce)" 1 "not available after 0s" enforce 1 <<EOF
ERR${T}ScanNotFoundException${T}scan not found
EOF

# ── the gate queries the exact digest it was given ───────────────────────────
gate "polls by digest, not by mutable tag"                             0 "no CRITICAL findings" enforce 1 <<EOF
OK${T}COMPLETE${T}None${T}None
EOF
if grep -q -- "--image-id imageDigest=$DIGEST" "$TMP/log"; then pass=$((pass+1)); echo "ok   - ECR was queried with imageDigest=<digest>"
else failn=$((failn+1)); echo "FAIL - ECR query did not use the digest: $(cat "$TMP/log")"; fi

# ── ecs-deploy.sh wiring: must stop BEFORE any ECS/migration call on a failed gate ──
deploy() { # name expect needle   (uses FAKE_SEQ already in $TMP/seq)
  local name="$1" want="$2" needle="$3"; shift 3
  : > "$TMP/log"; rm -f "$TMP/count"
  out="$(env "$@" PATH="$TMP/bin:$PATH" AWS_REGION=eu-central-1 FAKE_SEQ="$TMP/seq" FAKE_LOG="$TMP/log" \
    FAKE_COUNT="$TMP/count" ECR_SCAN_POLL_INTERVAL=0 ECR_SCAN_TIMEOUT_SECONDS=5 \
    bash "$DEPLOY" production "$TAG" https://api.example.test 2>&1)"; rc=$?
  local ok=1
  [ "$rc" = "$want" ] || ok=0
  [[ "$out" == *"$needle"* ]] || ok=0
  [[ "$out" == *unhandled* ]] && ok=0   # an ecs/run-task call reached the fake: the gate did not stop the deploy
  if [ "$ok" = 1 ]; then pass=$((pass+1)); echo "ok   - $name"
  else failn=$((failn+1)); echo "FAIL - $name (exit $rc, wanted $want, needle '$needle')"; sed 's/^/       /' <<<"$out"; fi
}
printf 'OK\tCOMPLETE\t1\tNone\n' > "$TMP/seq"
deploy "ecs-deploy: CRITICAL finding stops before registering task definitions" 1 "1 CRITICAL" \
  FAKE_ECR_DIGEST="$DIGEST" IMAGE_SCAN_GATE=enforce
printf 'OK\tFAILED\tNone\tbroken\n' > "$TMP/seq"
deploy "ecs-deploy: FAILED scan stops before registering task definitions"       1 "scan FAILED: broken" \
  FAKE_ECR_DIGEST="$DIGEST" IMAGE_SCAN_GATE=enforce
printf 'OK\tCOMPLETE\tNone\tNone\n' > "$TMP/seq"
deploy "ecs-deploy: ECR digest differs from the pushed digest is refused"        1 "refusing to deploy" \
  FAKE_ECR_DIGEST="$OTHER" EXPECTED_IMAGE_DIGEST="$DIGEST" IMAGE_SCAN_GATE=enforce
deploy "ecs-deploy: missing tag is refused"                                      1 "not found in ECR" \
  FAKE_ECR_DIGEST=None IMAGE_SCAN_GATE=enforce

echo; echo "passed=$pass failed=$failn"
[ "$failn" -eq 0 ]
