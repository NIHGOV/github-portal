gh api -H "Authorization: Bearer $(Get-Content -Raw token)" -H "Accept: application/vnd.github+json" /app/installations | jq >> app_output.json
