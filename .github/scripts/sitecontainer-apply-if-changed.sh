#!/usr/bin/env bash
set -euo pipefail

# @cspell: ignore argjson containername

APP_NAME=''
RESOURCE_GROUP=''
SLOT=''
CONTAINER_NAME=''
IS_MAIN=''
IMAGE=''

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
    --container-name)
      CONTAINER_NAME="$2"
      shift 2
      ;;
    --is-main)
      IS_MAIN="$2"
      shift 2
      ;;
    --image)
      IMAGE="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1"
      exit 1
      ;;
  esac
done

if [[ -z "$APP_NAME" || -z "$RESOURCE_GROUP" || -z "$CONTAINER_NAME" || -z "$IS_MAIN" || -z "$IMAGE" ]]; then
  echo 'Usage: sitecontainer-apply-if-changed.sh --name <app> --resource-group <rg> [--slot <slot>] --container-name <name> --is-main <true|false> --image <image>'
  exit 1
fi

SLOT_ARGS=()
if [[ -n "$SLOT" ]]; then
  SLOT_ARGS+=(--slot "$SLOT")
fi

CURRENT_CONTAINERS=$(az webapp sitecontainers list \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  "${SLOT_ARGS[@]}" \
  --output json)

CURRENT_IMAGE=$(jq -r \
  --arg container_name "$CONTAINER_NAME" \
  '
  map(select((.name // .containerName // "") == $container_name))
  | .[0]
  | (.image // .properties.image // "")
  ' <<< "$CURRENT_CONTAINERS")

if [[ "$CURRENT_IMAGE" == "$IMAGE" ]]; then
  echo "No sitecontainer image change for $APP_NAME/$CONTAINER_NAME${SLOT:+ slot $SLOT}. Skipping update."
  exit 0
fi

echo "Updating sitecontainer image for $APP_NAME/$CONTAINER_NAME${SLOT:+ slot $SLOT}."
az webapp sitecontainers update \
  --name "$APP_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  "${SLOT_ARGS[@]}" \
  --container-name "$CONTAINER_NAME" \
  --is-main "$IS_MAIN" \
  --image "$IMAGE"
