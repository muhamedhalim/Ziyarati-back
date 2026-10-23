#!/usr/bin/env bash
# Fails when a file that routinely carries credentials is TRACKED by git.
#
# Why: `infra/terraform/environments/production/tfplan-nat` / `tfplan-rds` were committed
# (a saved plan embeds the full Terraform state, including the Valkey AUTH token and the
# redis_url secret). `infra/.gitignore` listed `tfplan` but not `tfplan-*`, and nothing in CI
# looked at what was tracked. This is the cheap, deterministic backstop; history scanning
# (gitleaks) is a separate step in backend-ci.yml.
#
#   bash scripts/ci/check-tracked-secrets.sh            # checks the current tree
#   bash scripts/ci/check-tracked-secrets.sh --self-test
#
# Add a path to ALLOW only with a reason: the file must be a public/test artefact.
set -euo pipefail

# Reviewed exceptions (anchored regexes against the repo-relative path).
ALLOW=(
  '^test/fixtures/zt012-tls/'   # throw-away test CA/server keys for the database-tls e2e (trusted nowhere)
)

# Anything matching is a credential carrier.
DENY='(^|/)(tfplan[^/]*|[^/]*\.tfplan[^/]*|[^/]*\.tfstate(\.[^/]*)?|terraform\.tfvars\.json|crash\.log)$|(^|/)\.env(\.[^/]+)?$|\.(pem|key|p12|pfx|jks|keystore)$|(^|/)id_(rsa|dsa|ecdsa|ed25519)$|(^|/)\.npmrc$|(^|/)\.netrc$|(^|/)state\.json$'

find_offenders() {
  git ls-files -z \
    | tr '\0' '\n' \
    | grep -E "$DENY" \
    | grep -vE '(^|/)\.env\.example$' \
    | while IFS= read -r f; do
        allowed=0
        for a in "${ALLOW[@]}"; do
          if [[ "$f" =~ $a ]]; then allowed=1; break; fi
        done
        [[ $allowed -eq 0 ]] && printf '%s\n' "$f"
      done || true
}

if [[ "${1:-}" == "--self-test" ]]; then
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  git -C "$tmp" init -q
  mkdir -p "$tmp/infra/environments/production" "$tmp/test/fixtures/zt012-tls"
  : > "$tmp/infra/environments/production/tfplan-nat"
  : > "$tmp/terraform.tfstate.backup"
  : > "$tmp/.env.production"
  : > "$tmp/.env.example"
  : > "$tmp/test/fixtures/zt012-tls/ca.key"
  : > "$tmp/README.md"
  git -C "$tmp" add -A
  got="$(cd "$tmp" && find_offenders | sort | tr '\n' ' ')"
  want=".env.production infra/environments/production/tfplan-nat terraform.tfstate.backup "
  if [[ "$got" == "$want" ]]; then echo "self-test OK"; exit 0; fi
  echo "self-test FAILED: got '$got' want '$want'" >&2; exit 1
fi

offenders="$(find_offenders)"
if [[ -n "$offenders" ]]; then
  echo "::error::Credential-bearing files are tracked by git:" >&2
  printf '  %s\n' $offenders >&2
  echo "Remove them (git rm --cached <file>), ignore the pattern, and ROTATE anything they contained." >&2
  exit 1
fi
echo "No credential-bearing files are tracked."
