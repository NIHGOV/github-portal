#!/usr/bin/env bash
set -euo pipefail

# @cspell: ignore argjson slurpfile endgroup

APP_NAME=''
RESOURCE_GROUP=''
SLOT=''
SETTINGS_FILE=''

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)
      APP_NAME="$2"
      shift 2
      ;;
    --resource-group)
      RESOURCE_GROUP="$2"
      shift 2
      ;;
    --slot)
      SLOT="$2"
      shift 2
      ;;
    --settings-file)
      SETTINGS_FILE="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1"
      exit 1
      ;;
  esac
done

if [[ -z "$APP_NAME" || -z "$RESOURCE_GROUP" || -z "$SETTINGS_FILE" ]]; then
  echo 'Usage: appsettings-apply-if-changed.sh --name <app> --resource-group <rg> [--slot <slot>] --settings-file <json>'
  exit 1
fi

if [[ ! -f "$SETTINGS_FILE" ]]; then
  echo "::error::Settings file not found: $SETTINGS_FILE"
  exit 1
fi

echo '::group::Diagnostics: desired settings'
echo "Diagnostics: desired settings file path: $SETTINGS_FILE"
echo 'Diagnostics: desired settings payload:'
cat "$SETTINGS_FILE"
echo '::endgroup::'

SLOT_ARGS=()
if [[ -n "$SLOT" ]]; then
  SLOT_ARGS+=(--slot "$SLOT")
fi

CURRENT_SETTINGS=$(az webapp config appsettings list \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  "${SLOT_ARGS[@]}" \
  --output json)

echo "::group::Diagnostics: current app settings for $APP_NAME${SLOT:+ slot $SLOT}"
echo "Diagnostics: current app settings for $APP_NAME${SLOT:+ slot $SLOT}:"
echo "$CURRENT_SETTINGS"
echo '::endgroup::'

CHANGED_SETTINGS_FILE=$(mktemp)

jq -n \
  --slurpfile desired "$SETTINGS_FILE" \
  --argjson current "$CURRENT_SETTINGS" \
  '
  ($current
    | map(select(type == "object"))
    | map(select((.name | type) == "string" and (.name | length) > 0))
    | map({key: .name, value: .value})
    | from_entries) as $current_map
  | ((($desired[0] // [])
      | if type == "array" then . else [] end)
      | map(select(type == "object"))
      | map(select((.name | type) == "string" and (.name | length) > 0)))
  | map(select(($current_map[.name] // "__MISSING__") != .value))
  ' > "$CHANGED_SETTINGS_FILE"

CHANGED_COUNT=$(jq 'length' "$CHANGED_SETTINGS_FILE")
if [[ "$CHANGED_COUNT" -eq 0 ]]; then
  echo "No app settings changes detected for $APP_NAME${SLOT:+ slot $SLOT}. Skipping apply."
  rm -f "$CHANGED_SETTINGS_FILE"
  exit 0
fi

echo "Applying $CHANGED_COUNT changed app setting(s) for $APP_NAME${SLOT:+ slot $SLOT}."
echo "::group::Diagnostics: changed app settings for $APP_NAME${SLOT:+ slot $SLOT}"
echo 'Diagnostics: changed settings payload:'
cat "$CHANGED_SETTINGS_FILE"
echo '::endgroup::'
az webapp config appsettings set \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  "${SLOT_ARGS[@]}" \
  --settings @"$CHANGED_SETTINGS_FILE"

rm -f "$CHANGED_SETTINGS_FILE"
