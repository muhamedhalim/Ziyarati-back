# CI deploy role: the ecs:TagResource grant must stay narrow. ecs-deploy.sh re-registers
# task definitions with their tags, which ECS authorises through ecs:TagResource.
#   terraform -chdir=infra/terraform/modules/github-deploy init -backend=false
#   terraform -chdir=infra/terraform/modules/github-deploy test

mock_provider "aws" {
  source = "../../testing/aws"
}

variables {
  name                  = "zt-production"
  oidc_provider_arn     = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
  github_repository     = "muhamedhalim/Ziyarati-back"
  github_environment    = "production"
  ecr_repository_arn    = "arn:aws:ecr:eu-central-1:123456789012:repository/ziyaratech/backend"
  cluster_arn           = "arn:aws:ecs:eu-central-1:123456789012:cluster/zt-production"
  passable_role_arns    = ["arn:aws:iam::123456789012:role/zt-production-api-task"]
  migrate_log_group_arn = "arn:aws:logs:eu-central-1:123456789012:log-group:/ziyaratech/production/migrate"
}

run "tag_resource_is_scoped_to_the_three_task_definition_families" {
  command = plan

  assert {
    condition = length([
      for s in data.aws_iam_policy_document.deploy.statement : s
      if contains(s.actions, "ecs:TagResource")
    ]) == 1
    error_message = "Exactly one statement may grant ecs:TagResource"
  }

  assert {
    condition = alltrue([
      for s in data.aws_iam_policy_document.deploy.statement :
      alltrue([for r in s.resources : startswith(r, "arn:aws:ecs:") && strcontains(r, ":123456789012:task-definition/zt-production-")])
      if contains(s.actions, "ecs:TagResource")
    ])
    error_message = "ecs:TagResource must be limited to this account's zt-production task definitions (never *)"
  }

  assert {
    condition = alltrue([
      for s in data.aws_iam_policy_document.deploy.statement :
      length(s.resources) == 3 && !contains(s.resources, "*")
      if contains(s.actions, "ecs:TagResource")
    ])
    error_message = "Only the api, worker and migrate families may be tagged"
  }

  assert {
    condition = alltrue([
      for s in data.aws_iam_policy_document.deploy.statement :
      length([for c in s.condition : c if c.variable == "ecs:CreateAction" && contains(c.values, "RegisterTaskDefinition")]) == 1
      if contains(s.actions, "ecs:TagResource")
    ])
    error_message = "ecs:TagResource must only be usable as part of RegisterTaskDefinition"
  }

  assert {
    condition     = length([for s in data.aws_iam_policy_document.deploy.statement : s if contains(s.actions, "ecs:ListTasks") || contains(s.actions, "ecs:*") || contains(s.actions, "iam:*")]) == 0
    error_message = "No broader permissions were added"
  }
}

# Every IAM action on the real deploy path (traced from deploy-aws.yml, ecs-deploy.sh,
# ecr-scan-gate.sh and verify-deployed-image.sh). If one is dropped the deploy fails mid-run
# with AccessDenied, after the image was already pushed and the migration possibly started.
run "deploy_path_actions_are_all_granted" {
  command = plan

  assert {
    condition = alltrue([
      for a in [
        "ecr:GetAuthorizationToken", "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:DescribeImages",
        "ecr:DescribeImageScanFindings",
        "ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition", "ecs:TagResource",
        "ecs:RunTask", "ecs:DescribeTasks", "ecs:UpdateService", "ecs:DescribeServices",
        "iam:PassRole",
      ] : contains(flatten([for s in data.aws_iam_policy_document.deploy.statement : s.actions]), a)
    ])
    error_message = "A required deploy-path action is missing from the deploy role policy"
  }

  assert {
    condition = alltrue([
      for s in data.aws_iam_policy_document.deploy.statement :
      length([for c in s.condition : c if c.variable == "iam:PassedToService" && contains(c.values, "ecs-tasks.amazonaws.com")]) == 1
      if contains(s.actions, "iam:PassRole")
    ])
    error_message = "iam:PassRole must stay restricted to ecs-tasks.amazonaws.com"
  }

  assert {
    condition = alltrue([
      for s in data.aws_iam_policy_document.deploy.statement :
      length([for c in s.condition : c if c.variable == "ecs:cluster"]) == 1
      if contains(s.actions, "ecs:UpdateService")
    ])
    error_message = "Service/task actions must stay pinned to the production cluster"
  }
}
