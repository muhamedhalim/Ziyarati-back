terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source                = "hashicorp/aws"
      version               = ">= 6.0"
      configuration_aliases = [aws.dr]
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6"
    }
  }
}
