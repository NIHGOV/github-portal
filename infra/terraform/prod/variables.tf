variable "resource_group_name" {
  description = "Name of the prod Azure resource group"
  type        = string
}

variable "location" {
  description = "Azure region for all resources"
  type        = string
  default     = "eastus"
}

variable "log_analytics_workspace_name" {
  description = "Name for the Log Analytics workspace"
  type        = string
  default     = "nihgithubportal-logs"
}

variable "log_retention_days" {
  description = "Number of days to retain logs"
  type        = number
  default     = 30
}

variable "servicebus_namespace_name" {
  description = "Name of the Azure Service Bus namespace (will be created if it does not exist)"
  type        = string
  default     = "nihgithubportalsb"
}
