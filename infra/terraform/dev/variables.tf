variable "resource_group_name" {
  description = "Name of the dev Azure resource group"
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
  default     = "nihdevgithubportal-logs"
}

variable "log_retention_days" {
  description = "Number of days to retain logs"
  type        = number
  default     = 30
}

variable "servicebus_namespace_name" {
  description = "Name of the Azure Service Bus namespace (will be created if it does not exist)"
  type        = string
  default     = "nihdevgithubportalsb"
}

# The following reference resources that already exist and are managed outside Terraform (App
# Service, Postgres, Redis, ACR) -- only their diagnostic settings are managed here.
variable "app_service_name" {
  description = "Name of the existing App Service to wire up to Log Analytics"
  type        = string
  default     = "nihdevgithubportal"
}

variable "postgresql_flexible_server_name" {
  description = "Name of the existing PostgreSQL Flexible Server to wire up to Log Analytics"
  type        = string
  default     = "nihdevgithubportaldb"
}

variable "redis_name" {
  description = "Name of the existing Azure Cache for Redis instance to wire up to Log Analytics"
  type        = string
  default     = "nihdevgithubportal"
}

variable "container_registry_name" {
  description = "Name of the existing Azure Container Registry to wire up to Log Analytics"
  type        = string
  default     = "nihdevgithubportal"
}

# The existing 'servicebus' Logic App connection was created in centralus, unlike the newer
# resources above (var.location/eastus) -- managed_api_id is ForceNew, so this must match the
# connection's actual region or Terraform will destroy and recreate it instead of updating in place.
variable "servicebus_managed_api_location" {
  description = "Region of the existing 'servicebus' managed API connection"
  type        = string
  default     = "centralus"
}
