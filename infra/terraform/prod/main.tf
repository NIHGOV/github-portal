resource "azurerm_log_analytics_workspace" "main" {
  name                = var.log_analytics_workspace_name
  location            = var.location
  resource_group_name = var.resource_group_name
  sku                 = "PerGB2018"
  retention_in_days   = var.log_retention_days
}

data "azurerm_servicebus_namespace" "main" {
  name                = var.servicebus_namespace_name
  resource_group_name = var.resource_group_name
}

resource "azurerm_user_assigned_identity" "firehose" {
  name                = "nihgithubportal-firehose"
  resource_group_name = var.resource_group_name
  location            = var.location
}

resource "azurerm_role_assignment" "firehose_servicebus" {
  scope                = data.azurerm_servicebus_namespace.main.id
  role_definition_name = "Azure Service Bus Data Receiver"
  principal_id         = azurerm_user_assigned_identity.firehose.principal_id
}
