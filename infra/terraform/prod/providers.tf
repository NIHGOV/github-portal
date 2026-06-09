terraform {
  required_version = ">= 1.5"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.110"
    }
  }

  # Backend config is supplied at init time via -backend-config flags.
  # Required keys: storage_account_name, container_name, resource_group_name, key
  backend "azurerm" {}
}

provider "azurerm" {
  features {}

  # Authenticates via OIDC federated identity (no client secret).
  # ARM_CLIENT_ID, ARM_TENANT_ID, ARM_SUBSCRIPTION_ID are set from env by the workflow.
  use_oidc = true
}
