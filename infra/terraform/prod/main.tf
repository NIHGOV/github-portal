resource "azurerm_log_analytics_workspace" "main" {
  name                = var.log_analytics_workspace_name
  location            = var.location
  resource_group_name = var.resource_group_name
  sku                 = "PerGB2018"
  retention_in_days   = var.log_retention_days
}

resource "azurerm_servicebus_namespace" "main" {
  name                = var.servicebus_namespace_name
  location            = var.location
  resource_group_name = var.resource_group_name
  sku                 = "Standard"
}

resource "azurerm_servicebus_queue" "events" {
  name         = "events"
  namespace_id = azurerm_servicebus_namespace.main.id
}

resource "azurerm_servicebus_queue_authorization_rule" "events_send" {
  name     = "send-events"
  queue_id = azurerm_servicebus_queue.events.id
  send     = true
}

data "azurerm_managed_api" "servicebus" {
  name     = "servicebus"
  location = var.servicebus_managed_api_location
}

# Pre-existing Logic App connection (nihgithubportalevents' webhook-publishing workflow already
# references $connections['servicebus']) -- must be `terraform import`ed before first apply, since
# it already exists. Only the connection string changes here, to point at the queue above instead
# of the old pre-migration namespace; the Logic App's own definition is untouched. display_name is
# intentionally omitted so the existing value is left as-is rather than renamed.
resource "azurerm_api_connection" "servicebus" {
  name                = "servicebus"
  resource_group_name = var.resource_group_name
  managed_api_id      = data.azurerm_managed_api.servicebus.id

  parameter_values = {
    connectionString = azurerm_servicebus_queue_authorization_rule.events_send.primary_connection_string
  }

  # TODO: once this first apply has repointed the connection, add
  #   lifecycle { ignore_changes = [parameter_values] }
  # (as already done in infra/terraform/dev/main.tf) in a follow-up commit. Azure never returns
  # this secure value on refresh, so every plan after that first apply will otherwise see it as
  # drifted and force-replace the connection again. Not added yet: doing so before the initial
  # apply would make Terraform ignore setting the new value at all, leaving prod not repointed.
}

resource "azurerm_user_assigned_identity" "firehose" {
  name                = "nihgithubportal-firehose"
  resource_group_name = var.resource_group_name
  location            = var.location
}

resource "azurerm_role_assignment" "firehose_servicebus" {
  scope                = azurerm_servicebus_namespace.main.id
  role_definition_name = "Azure Service Bus Data Receiver"
  principal_id         = azurerm_user_assigned_identity.firehose.principal_id
}

# References to existing resources managed outside Terraform -- only their diagnostic settings
# (below) are managed here, so nothing about the resources themselves is touched.
data "azurerm_resources" "app_service" {
  name                = var.app_service_name
  resource_group_name = var.resource_group_name
  type                = "Microsoft.Web/sites"
}

data "azurerm_postgresql_flexible_server" "main" {
  name                = var.postgresql_flexible_server_name
  resource_group_name = var.resource_group_name
}

data "azurerm_redis_cache" "main" {
  name                = var.redis_name
  resource_group_name = var.resource_group_name
}

data "azurerm_container_registry" "main" {
  name                = var.container_registry_name
  resource_group_name = var.resource_group_name
}

resource "azurerm_monitor_diagnostic_setting" "app_service" {
  name                       = "send-to-law"
  target_resource_id         = data.azurerm_resources.app_service.resources[0].id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category = "AppServiceHTTPLogs"
  }
  enabled_log {
    category = "AppServiceConsoleLogs"
  }
  enabled_log {
    category = "AppServiceAppLogs"
  }
  enabled_log {
    category = "AppServicePlatformLogs"
  }

  metric {
    category = "AllMetrics"
    enabled  = true
  }
}

resource "azurerm_monitor_diagnostic_setting" "postgresql" {
  name                       = "send-to-law"
  target_resource_id         = data.azurerm_postgresql_flexible_server.main.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category = "PostgreSQLLogs"
  }

  metric {
    category = "AllMetrics"
    enabled  = true
  }
}

resource "azurerm_monitor_diagnostic_setting" "redis" {
  name                       = "send-to-law"
  target_resource_id         = data.azurerm_redis_cache.main.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category = "ConnectedClientList"
  }

  metric {
    category = "AllMetrics"
    enabled  = true
  }
}

resource "azurerm_monitor_diagnostic_setting" "container_registry" {
  name                       = "send-to-law"
  target_resource_id         = data.azurerm_container_registry.main.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category = "ContainerRegistryRepositoryEvents"
  }
  enabled_log {
    category = "ContainerRegistryLoginEvents"
  }

  metric {
    category = "AllMetrics"
    enabled  = true
  }
}

resource "azurerm_monitor_diagnostic_setting" "servicebus" {
  name                       = "send-to-law"
  target_resource_id         = azurerm_servicebus_namespace.main.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category = "OperationalLogs"
  }

  metric {
    category = "AllMetrics"
    enabled  = true
  }
}
