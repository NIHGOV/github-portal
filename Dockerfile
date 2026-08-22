#
# Copyright (c) Microsoft.
# Licensed under the MIT license. See LICENSE file in the project root for full license information.
#

ARG IMAGE_NAME=mcr.microsoft.com/azurelinux/base/core:3.0

FROM $IMAGE_NAME AS node24-base

RUN tdnf -y update --quiet && \
    tdnf -y install --quiet ca-certificates nodejs24 && \
    tdnf clean all --quiet

# Install bun — single statically-linked binary, copied from the official image
COPY --from=oven/bun:1 /usr/local/bin/bun /usr/local/bin/bun

FROM node24-base AS build

WORKDIR /build

COPY . .
RUN rm -rf dist frontend/build

### Backend

# Install all deps (bun reads .npmrc for registry auth automatically)
RUN bun install --frozen-lockfile --ignore-scripts
RUN bun run build
# Prune to production deps only, then snapshot for the run stage
RUN rm -rf node_modules && bun install --frozen-lockfile --ignore-scripts --production
RUN mv node_modules production_node_modules

### Legacy static server-rendered site assets

# The open source project build needs: build the site assets sub-project
RUN cd default-assets-package && bun install --frozen-lockfile --ignore-scripts && bun run build

### Frontend

WORKDIR /build/frontend

RUN --mount=type=secret,id=npmrc,target=/root/.npmrc bun install --frozen-lockfile --ignore-scripts
RUN bun run build

FROM node24-base AS run

ENV IS_DOCKER=1 \
    NPM_CONFIG_LOGLEVEL=warn \
    DEBUG=startup \
    PORT=3000

EXPOSE 3000

WORKDIR /usr/src/repos

# Production Node.js modules
COPY --from=build /build/production_node_modules ./node_modules

# People not using painless config may need
COPY --from=build /build/data ./data

# Copy built assets, app, config map
COPY --from=build /build/dist ./

# No frontend/ directory in this fork (FRONTEND_MODE=skip); omit those COPY steps.

# The open source project build needs: default assets should be placed
COPY --from=build /build/default-assets-package ./default-assets-package

COPY --from=build /build/config ./config
COPY --from=build /build/views ./views
COPY --from=build /build/package.json ./package.json

# Only if needed, copy our environment
# COPY --from=build /build/.environment ./.environment

# Only if needed, binary resources
# COPY --from=build /build/microsoft/assets ./microsoft/assets

# Only if needed, binary resources
# COPY --from=build /build/microsoft/jobs/assets ./microsoft/jobs/assets

# Only if needed, sidecar resources
# COPY --from=build /build/microsoft/sites/mise-sidecar/configs ./microsoft/sites/mise-sidecar/configs


ENTRYPOINT ["node", "./bin/www"]
