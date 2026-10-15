# ZiyaraTech — ORGANISATION GUARDRAILS (residency plan T14). No secrets here.
#
# EVERYTHING BELOW IS EMPTY ON PURPOSE. Planning this root fails closed (module
# variable validation) until:
#   1. an AWS Organization exists with SERVICE_CONTROL_POLICY enabled,
#   2. the hosting location is approved in writing (residency plan L1/L2),
#   3. the rollout in infra/runbooks/org-guardrails-rollout.md is started.
# management_account_id comes from TF_VAR_management_account_id.

# AWS documents us-east-1 as the Organizations API region — confirm before use.
organizations_api_region = "us-east-1"

# Test OU / account first; the organisation root last.
target_ids = []

# Superset of every environment's approved_regions (region-gate.sh enforces it).
approved_regions = []

# Role ARNs, not assumed-role session ARNs. Wildcards allowed in the account id.
audit_exempt_principal_arns = []

# Vaults AWS Backup may copy into (DR scenario, L13). Empty = no backup copy.
approved_backup_vault_arns = []
