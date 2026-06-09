output "workspace_id" {
  description = "Log Analytics workspace ID (customer ID). Looked up at deploy time via az monitor — not stored as a secret."
  value       = azurerm_log_analytics_workspace.main.workspace_id
}

output "primary_shared_key" {
  description = "Log Analytics primary shared key. Looked up at deploy time via az monitor — not stored as a secret."
  value       = azurerm_log_analytics_workspace.main.primary_shared_key
  sensitive   = true
}

output "firehose_identity_id" {
  description = "Resource ID of the firehose user-assigned managed identity. Used with --assign-identity in az container create."
  value       = azurerm_user_assigned_identity.firehose.id
}

output "firehose_identity_client_id" {
  description = "Client ID of the firehose managed identity. Passed as AZURE_CLIENT_ID to the ACI container so DefaultAzureCredential selects the right identity."
  value       = azurerm_user_assigned_identity.firehose.client_id
}

output "servicebus_endpoint" {
  description = "Fully qualified Service Bus namespace endpoint URL."
  value       = data.azurerm_servicebus_namespace.main.endpoint
}
