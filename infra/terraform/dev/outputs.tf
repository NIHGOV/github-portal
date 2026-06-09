output "workspace_id" {
  description = "Log Analytics workspace ID (customer ID). Looked up at deploy time via az monitor — not stored as a secret."
  value       = azurerm_log_analytics_workspace.main.workspace_id
}

output "primary_shared_key" {
  description = "Log Analytics primary shared key. Looked up at deploy time via az monitor — not stored as a secret."
  value       = azurerm_log_analytics_workspace.main.primary_shared_key
  sensitive   = true
}
