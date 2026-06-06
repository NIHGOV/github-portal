output "workspace_id" {
  description = "Workspace ID — store as GitHub Secret DEV_LOG_ANALYTICS_WORKSPACE_ID"
  value       = azurerm_log_analytics_workspace.main.workspace_id
}

output "primary_shared_key" {
  description = "Primary key — store as GitHub Secret DEV_LOG_ANALYTICS_WORKSPACE_KEY"
  value       = azurerm_log_analytics_workspace.main.primary_shared_key
  sensitive   = true
}
