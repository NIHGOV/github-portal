# Security Improvement Plan

Priority-ordered list of security improvements identified across this repository.

---

## Terraform Infrastructure (June 2026)

`infra/terraform/dev/` manages Azure resources in `GitHub_OpenSource_Portal_Dev`.
Long-term goal: represent the entire `GitHub_OpenSource_Portal_Dev` (and eventually
`GitHub_OpenSource_Portal`) resource group in Terraform.

### Bootstrap (one-time, manual)

Before the workflow can run, a storage account for Terraform state must exist:

1. Create a storage account in `GitHub_OpenSource_Portal_Dev` (e.g. `nihdevgithubportaltf`)
2. Create a blob container in it (e.g. `tfstate`)
3. Add GitHub Secrets:
   - `DEV_TF_STORAGE_ACCOUNT` → storage account name
   - `DEV_TF_STORAGE_CONTAINER` → container name (e.g. `tfstate`)

### Resources managed

- [ ] `azurerm_log_analytics_workspace` — `nihdevgithubportal-logs`
- [ ] After first apply: copy outputs to GitHub Secrets
  - `DEV_LOG_ANALYTICS_WORKSPACE_ID` ← `terraform output workspace_id`
  - `DEV_LOG_ANALYTICS_WORKSPACE_KEY` ← `terraform output -raw primary_shared_key`

### Future: full resource group coverage

- [ ] Redis Cache (`nihdevgithubportal`)
- [ ] PostgreSQL Flexible Server (`nihdevgithubportaldb`)
- [ ] Service Bus namespace
- [ ] Container Registry
- [ ] App Service (`nihdevgithubportal`)
- [ ] ACI container groups (firehose, cache builder)
- [ ] Repeat for `GitHub_OpenSource_Portal` (prod)

---

## ACI Container Deployment (June 2026)

Replaced hardcoded-secret YAML files with GitHub Actions workflows and `infra/aci/` reference configs.

### Staging

- [x] Add GitHub Secret `DEV_REDIS_TLS_HOST`
- [x] Add GitHub Secret `DEV_REDIS_KEY`
- [x] Add GitHub Secret `DEV_POSTGRES_HOST`
- [x] Add GitHub Secret `DEV_POSTGRES_DB`
- [x] Add GitHub Secret `DEV_POSTGRES_USER`
- [x] Add GitHub Secret `DEV_POSTGRES_PASSWORD`
- [x] Add GitHub Secret `DEV_SERVICEBUS_CONNECTIONSTRING`
- [x] Add GitHub Secret `DEV_GITHUB_APP_OPERATIONS_APP_ID`
- [x] Add GitHub Secret `DEV_GITHUB_APP_OPERATIONS_KEY`
- [x] Add GitHub Secret `DEV_GITHUB_APP_OPERATIONS_SLUG`
- [ ] Run `staging_nihdevgithubportalfh.yml` manually — verify firehose container starts and logs appear
- [ ] Run `staging_nihdevgithubportalcb.yml` manually — verify cache builder runs and `portaldescription` is written to DB for ARPA-H
- [ ] Restart `nihdevgithubportal` App Service — confirm ARPA-H org description shows on homepage

### Production

- [ ] Add GitHub Secret `PROD_RG` → `GitHub_OpenSource_Portal`
- [ ] Add GitHub Secrets `PROD_AAD_CLIENT_ID`, `PROD_AAD_CLIENT_SECRET`, `PROD_AAD_SUBSCRIPTION_ID`, `PROD_AAD_TENANT_ID` (may match existing `AAD_*` values)
- [ ] Add GitHub Secret `PROD_REDIS_TLS_HOST`
- [ ] Add GitHub Secret `PROD_REDIS_KEY`
- [ ] Add GitHub Secret `PROD_POSTGRES_HOST`
- [ ] Add GitHub Secret `PROD_POSTGRES_DB`
- [ ] Add GitHub Secret `PROD_POSTGRES_USER`
- [ ] Add GitHub Secret `PROD_POSTGRES_PASSWORD`
- [ ] Add GitHub Secret `PROD_SERVICEBUS_CONNECTIONSTRING`
- [ ] Add GitHub Secret `PROD_GITHUB_APP_OPERATIONS_APP_ID`
- [ ] Add GitHub Secret `PROD_GITHUB_APP_OPERATIONS_KEY`
- [ ] Add GitHub Secret `PROD_GITHUB_APP_OPERATIONS_SLUG`
- [ ] Run `main_nihgithubportalfh.yml` manually — verify firehose starts
- [ ] Run `main_nihgithubportalcb.yml` manually — verify cache builder runs

---

## Completed (June 2026 — GitHub Copilot agentic session)

### ✅ Fixed admin apps page showing wrong GitHub App slug and broken "Install in new org" link (June 2026)

`/administration/apps` displayed the slug from `GITHUB_APP_OPERATIONS_SLUG` as both the "GitHub App" and "Purpose" columns, and used that slug to build the "Install in new org" link. Two issues combined to cause the broken link and misleading display:

1. **Wrong env var value**: `GITHUB_APP_OPERATIONS_SLUG` was set to `nihdevgithubportal-app-ops` (the old/renamed app name) instead of the current slug `dev-nih-github-management-portal`. Fix: update the App Service setting to match the actual slug shown at `github.com/organizations/NIHGOV/settings/apps/…`.

2. **Code bug**: `initializeAppById` in `business/operations/core.ts` called `tokenManager.getSlugById()` for _both_ the `slug` and `friendlyName` parameters, so the "Purpose" column showed the raw slug instead of the human-readable description (e.g. "GitHub Operations") from the app's JSON config.

Code fix:

- `lib/github/tokenManager.ts` — added `_appFriendlyNames` map; populated it alongside `_appSlugs` in `initializeApp`; added `getFriendlyNameById()` accessor
- `business/operations/core.ts` — `initializeAppById` now calls `getFriendlyNameById()` for the friendlyName, falling back to the slug only when no description is configured
- `AGENTS.md` — documented `GITHUB_APP_OPERATIONS_SLUG` in the required App Service settings table

**⚠️ Required before merging to main:** Verify `GITHUB_APP_OPERATIONS_SLUG` is set correctly on both App Services (`nihdevgithubportal` and `nihgithubportal`). The value must exactly match the slug shown at `github.com/organizations/NIHGOV/settings/apps/…` (e.g. `dev-nih-github-management-portal` on staging). An incorrect slug causes broken "Install in new org" links and silently misidentifies bot commits in `getApplicationsAsLogins()`.

## Completed (May 2026 — GitHub Copilot agentic session)

### ✅ Fixed version always showing 8.5.0 instead of 8.5.\<build\> (May 2026)

`continuousDeployment.js` constructs the displayed version as `major.minor.GITHUB_RUN_NUMBER`, but `GITHUB_RUN_NUMBER` is only set during a GitHub Actions run — not on the deployed App Service. The packaging step never stamped the placeholder in `package.json`, so `stripPlaceholders()` deleted it and the code fell back to the literal `pkg.version` string `8.5.0`.

- `.github/workflows/staging_nihdevgithubportal.yml` — added a "Stamp build number" step before packaging that runs `sed` to replace `__Build_BuildNumber__`, `__Build_BranchName__`, and `__Build_SourceVersion__` with `github.run_number`, `github.ref_name`, and `github.sha` respectively (same approach already used by `container.yml`)
- `.github/workflows/main_nihgithubportal.yml` — same stamp step added

### ✅ Migrated production workflow to `WEBSITE_RUN_FROM_PACKAGE=1` (May 2026)

`main_nihgithubportal.yml` still used the legacy Kudu additive `tar.gz` deploy, which accumulates stale nested `node_modules` across deploys and causes `createTracingClient` ESM export crashes. Updated to match `staging_nihdevgithubportal.yml`:

- Removed `tar -czf output.tar.gz` + "Unpack tar" steps; replaced with `rsync` + `zip` into `/tmp/node-app.zip` with `github-portal/` as the root entry
- Added bun dependency cache step
- Added `Strip dev artifacts` step (`find node_modules -name '*.map' -delete` + `*.d.ts`)
- Added `Stamp build number` step (fixes version display, same as staging)
- Passes `package: node-app.zip` directly to `azure/webapps-deploy` (no re-zip)
- Added bun-version: latest + comments mirroring staging

**Still required (one-time manual action in Azure portal):** Apply the `WEBSITE_RUN_FROM_PACKAGE=1` App Service settings to `nihgithubportal` before the first deploy from `main` — see §0 below.

### ✅ Synced upstream microsoft/opensource-management-portal → NIHGOV:staging (PR #1099)

Merged `microsoft/opensource-management-portal:main` into `NIHGOV/github-portal:staging` on branch `sync-upstream-main-20260527`. Resolved 7 merge conflicts, preserving NIH-specific code:

- `config/features.json` + `config/features.types.ts` — retained `allowUsersToViewLockedOrgDetails` (NIH) alongside new upstream `allowSessionFeatureFlags`
- `views/layout.pug` — retained NIH's Google Analytics iframe inside upstream's new `data-csrf-token` body attribute
- `package.json` — retained NIH deps (`js-yaml`, `json-2-csv`); adopted upstream `jose` upgrade
- `routes/org/index.ts` — adopted upstream `stringParam()` (not NIH-specific)
- `.vscode/settings.json` — deleted (honored NIH staging commit)
- `package-lock.json` — replaced with `bun.lock` (see migration below)

### ✅ Migrated from npm to bun (PR #1099)

- All `package.json` scripts: `npm`/`npx` → `bun`/`bunx`
- Generated `bun.lock` (SHA-512 pinned, replaces `package-lock.json`)
- Generated `default-assets-package/bun.lock`
- `Dockerfile` + `Dockerfile.open`: `npm install` → `bun install --frozen-lockfile --ignore-scripts`; ENTRYPOINT updated
- `.devcontainer/devcontainer.json`: rewrote to use `mcr.microsoft.com/devcontainers/javascript-node:24`, added `oven-sh/setup-bun` and `github-cli` features, `postCreateCommand: bun install --frozen-lockfile`

### ✅ Fixed 4 GHAS security alerts (PR #1099)

- `api/index.ts` — removed `isClientRoute()` bypasses from pre-auth and post-auth rate limiters; all routes now go through rate limiting
- `middleware/rateLimit.ts` — replaced `crypto.createHmac('sha256', 'rate-limit-cache-key')` with `crypto.createHash('sha256')` (was flagged as insufficient password hash)
- `api/client/context/diagnostics.ts` — wrapped handler in `getRateLimitMiddleware` to fix missing rate limit alert

### ✅ Fixed Redis v5 breaking API changes (PR #1100)

- `middleware/initialize.ts` — removed `await redisClient.auth({password: ...})` (removed in v5); moved `password` to top-level `createClient()` option
- `middleware/session.ts` — removed `await redisLegacy.auth({password: ...})`; properly awaited `redisLegacy.connect()`

### ✅ Fixed CI/CD workflows: Node 24 + bun (PR #1101)

- `staging_nihdevgithubportal.yml` — Node 20 → 24 (match App Service runtime); `npm install` → `bun install --frozen-lockfile --ignore-scripts`; added devDep pruning before packaging; split into explicit build/test/prune steps
- `main_nihgithubportal.yml` — Node 16 → 24; same npm → bun migration; bumped `actions/checkout`, `upload/download-artifact`, `webapps-deploy` to latest
- `ci.yml` — added `oven-sh/setup-bun@v2`; replaced all `npm` with `bun` equivalents; Node → 24

Root cause: `npm install` was running with no `package-lock.json` (deleted in bun migration), so npm did unconstrained fresh resolution ignoring `bun.lock`, resulting in wrong transitive versions being deployed (caused `@azure/core-tracing`/`createTracingClient` export error on startup).

### ✅ SHA-pinned all GitHub Actions + upgraded to latest versions

All `uses:` references across all 10 workflow files pinned to exact commit SHAs to prevent supply-chain attacks via tag mutation:

| Action                      | Old         | New                   |
| --------------------------- | ----------- | --------------------- |
| `actions/checkout`          | v2/v3/v4/v6 | `de0fac2e` (v6.0.2)   |
| `actions/setup-node`        | v3/v4       | `48b55a01` (v6.4.0)   |
| `actions/upload-artifact`   | v3/v4       | `043fb46d` (v7.0.1)   |
| `actions/download-artifact` | v3/v4       | `3e5f45b2` (v8.0.1)   |
| `actions/stale`             | v9          | `eb5cf3af` (v10.3.0)  |
| `oven-sh/setup-bun`         | v2          | `0c5077e5` (v2.2.0)   |
| `azure/webapps-deploy`      | v2/v3       | `02a81bea` (v3)       |
| `azure/login`               | v1.4.6/v2   | `532459ea` (v3.0.0)   |
| `Azure/cli`                 | v1          | `9eb25b83` (v3.0.0)   |
| `azure/docker-login`        | v1          | `15c4aadf` (v2)       |
| `github/codeql-action`      | v3          | `03e4368a` (v3.36.0)  |
| `ruby/setup-ruby`           | v1.127.0    | `ee211353` (v1.127.0) |
| `azure/postgresql`          | v1          | `59401b78` (v1.2.0)   |

### ✅ Updated GitHub Actions: Node 20 → 24, fresher pins (June 2026)

Follow-up pass on all 10 workflow files to eliminate Node 20 runtime warnings and bring outdated pins to current:

| Action                     | Old                           | New                                | Reason                               |
| -------------------------- | ----------------------------- | ---------------------------------- | ------------------------------------ |
| `azure/docker-login`       | `15c4aadf` (v2, Node 20)      | replaced — see below               | Still uses Node 20; no v3 planned    |
| `docker/login-action`      | _(not used)_                  | `650006c6` (v4.2.0, Node 24)       | First-party Docker action; Node 24   |
| `ruby/setup-ruby`          | `ee211353` (v1.127.0)         | `afeafc3d` (v1.310.0)              | 183 patch releases behind            |
| `github/codeql-action`     | comment said `v3`             | comment updated to `v3.36.0`       | SHA was correct; comment imprecise   |
| `azure/webapps-deploy`     | comment said `v3`             | comment updated to `v3.0.8`        | SHA was correct; comment imprecise   |
| `azure/postgresql`         | comment said `v1`             | comment updated to `v1.2.0`        | SHA was correct; comment imprecise   |
| `docker/build-push-action` | `@v3` (no SHA, commented out) | `f9f3042f` (v7.2.0, commented out) | SHA-pinned for when it is re-enabled |

`azure/docker-login@v2` was the sole source of Node 20 deprecation warnings — its `action.yml` specifies `using: node20`. All other actions confirmed on Node 24. Replaced with `docker/login-action@v4.2.0` which is the official Docker-maintained equivalent; only interface change is `login-server:` → `registry:`.

### ✅ Upgraded `applicationinsights` 2.9.8 → 3.15.0 (OpenTelemetry)

Fixes `DEP0005` (`Buffer()`) and `DEP0169` (`url.parse()`) deprecation warnings on Node.js 24. Breaking API changes addressed:

- `lib/mail/render.ts` + `render.test.ts` — replaced `import type NodeClient from 'applicationinsights/out/Library/NodeClient.js'` (internal v2 path, broken in v3) with `import type { TelemetryClient } from 'applicationinsights'`
- `middleware/appInsights.ts` — removed `wrapWithCorrelationContext` / `getCorrelationContext` / `startOperation` (v2 correlation model removed; v3 propagates context automatically via OpenTelemetry async hooks); removed deprecated `instrumentationKey` reference

### ✅ Suppressed OTel/require-in-the-middle verbose log flood (May 2026)

`applicationinsights` v3 is built on OpenTelemetry and logs every `require()` intercept to stderr at VERBOSE level, flooding Azure's ERROR log stream.

- `middleware/appInsights.ts` — added `diag.setLogger({…}, DiagLogLevel.NONE)` from `@opentelemetry/api` before SDK setup to silence all OTel diagnostic output
- `package.json` — added `@opentelemetry/api` as a direct dependency (was transitive-only; lint rule requires explicit declaration)

**Note:** The `DEBUG` Azure App Service env var (if set to `*` or a broad pattern) separately causes `debug`-module output from `router`, `body-parser`, `express-session`, etc. to appear as ERROR-level logs. Remove the `DEBUG` app setting in the portal to silence that flood.

### ✅ Guarded per-request JSON.parse failures with logging + safe fallback (May 2026)

The app was crashing on every authenticated page with `SyntaxError: Unexpected token '', "❬U+FFFD❭"…` but the error was going to stdout (INFO), invisible in Azure's ERROR log stream.

- `middleware/business/authentication.ts` — wrapped `JSON.parse(oauthToken)` in try/catch; logs to `console.error` with correlation ID and token prefix; falls back to `signoutThenSignIn()` to clear corrupted session
- `middleware/errorHandler.ts` — changed primary error log from `console.log` → `console.error` so all error messages appear in Azure's ERROR stream; wrapped `JSON.parse(err.data)` in try/catch to prevent the error handler itself from crashing mid-response

### ✅ Fixed CI test runner (vitest vs bun native runner) (May 2026)

All 3 CI test failures were caused by `ci.yml` running `bun test` (Bun's native Jest-compatible runner) while the test files explicitly `import { describe, expect, test } from 'vitest'` and the project is configured with `vitest.config.ts`. The two runners handle `.not.toThrow()` and Chai-style assertions differently.

- `.github/workflows/ci.yml` — changed `bun test` → `bun run test` (runs `vitest run` per `package.json` scripts)
- `AGENTS.md` — updated documented test command to match

### ✅ Fixed Redis v5 `withCommandOptions` typeMapping for compressed cache (May 2026)

Every request hitting a cached GitHub API result (org members, repos, teams) was throwing `SyntaxError: Unexpected token '', "❬U+FFFD❭"` traced to `RedisHelper.getObjectCompressed`.

**Root cause:** `_redisForBuffers` was created with `{ [RESP_TYPES.BLOB_STRING]: Buffer }` but redis v5 requires the type override under a `typeMapping` key. Without it the client decoded gzip-compressed binary as UTF-8 (producing U+FFFD replacement chars), which then failed `JSON.parse` after the corrupt string bypassed gunzip via the `Z_DATA_ERROR` fallback path.

- `lib/caching/redis.ts` — changed `withCommandOptions({ [RESP_TYPES.BLOB_STRING]: Buffer })` → `withCommandOptions({ typeMapping: { [RESP_TYPES.BLOB_STRING]: Buffer } })`

### ✅ Fixed missing and crashing octicon + hardened helper (May 2026)

`@primer/octicons` v19 removed `primitive-dot` (renamed to `dot-fill`). The octicon helper threw an uncaught `Error` on any unknown icon name, crashing the entire Pug render and returning a 500.

- `views/repos/index.pug`, `views/repos/repo.pug`, `views/org/team/index.pug` — `primitive-dot` → `dot-fill`
- `lib/pugViewServices.ts` — changed throw → `console.warn` + `return ''` so an unknown icon name renders as empty rather than crashing the page

### ✅ Suppressed mouse-click focus ring (Edge Chromium accessibility change) (May 2026)

Edge 102+ strengthened the default `:focus` ring to a thick double-ring (blue + white offset) for WCAG 2.1 AA compliance. Bootstrap 3 triggers `:focus` on mouse clicks (not just keyboard), making every anchor click show the heavy ring.

- `default-assets-package/resources/repos-css/oss.css` — added `a:focus:not(:focus-visible) { outline: none; }` to suppress the ring for pointer clicks while preserving it for keyboard navigation

---

## High Priority

### 0. **Before merging `staging` to `main`: apply `WEBSITE_RUN_FROM_PACKAGE=1` to `nihgithubportal` App Service**

The production **workflow** (`main_nihgithubportal.yml`) has been updated to use zip packaging + run-from-package (see Completed section above). But the **Azure App Service itself** still needs its settings updated — otherwise the first deploy from `main` will crash because the App Service still expects the old Kudu additive model.

**If the app crash-loops with:**

```text
SyntaxError: The requested module '@azure/core-tracing' does not provide an export named 'createTracingClient'
```

the App Service settings below were not yet applied. Apply them and redeploy.

#### Required one-time settings (Azure portal → `nihgithubportal` → Configuration)

| Name                               | Value                                                |
| ---------------------------------- | ---------------------------------------------------- |
| `WEBSITE_RUN_FROM_PACKAGE`         | `1`                                                  |
| `SCM_DO_BUILD_DURING_DEPLOYMENT`   | `false`                                              |
| `ENABLE_ORYX_BUILD`                | `false`                                              |
| Startup Command (General settings) | `node /home/site/wwwroot/github-portal/dist/bin/www` |

Or via Azure CLI:

```bash
az webapp config appsettings set --name nihgithubportal --resource-group <RG> \
  --settings WEBSITE_RUN_FROM_PACKAGE=1 SCM_DO_BUILD_DURING_DEPLOYMENT=false ENABLE_ORYX_BUILD=false
az webapp config set --name nihgithubportal --resource-group <RG> \
  --startup-file "node /home/site/wwwroot/github-portal/dist/bin/www"
```

#### Caveat — read-only `wwwroot`

With `WEBSITE_RUN_FROM_PACKAGE=1`, the app **cannot write to `/home/site/wwwroot`**. Anything writable must live under `/home/` (the persistent share, separate from `wwwroot`). Audit any code that writes to its own directory (logs, uploads, caches) before flipping the switch in production.

See `AGENTS.md` for the debugging checklist if the production app crash-loops with this error after the staging→main merge.

#### Also add the renamed Entra env vars to both App Services

The upstream sync (commit `55c10cfe`) completely restructured `config/activeDirectory.json`, renaming all app registration env vars from `AAD_*` to `ENTRA_*`. Both App Services need these new names **alongside** the old ones (do not rename — other config paths still reference `AAD_ISSUER`, `AAD_BLOCK_GUESTS`, etc.):

| Add this new setting     | Copy value from     |
| ------------------------ | ------------------- |
| `ENTRA_ID_CLIENT_ID`     | `AAD_CLIENT_ID`     |
| `ENTRA_ID_CLIENT_SECRET` | `AAD_CLIENT_SECRET` |
| `ENTRA_ID_TENANT_ID`     | `AAD_TENANT_ID`     |

Without these, the app throws `No Entra application configuration found` on startup.

#### Additional required App Service settings (discovered during staging debug)

The following settings are also required or the app crashes/misbehaves at runtime:

| Setting                                      | Value                                                                                                                                | Why                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `AUTHENTICATION_SCHEME`                      | `entra-id`                                                                                                                           | Default `aad` throws on startup since upstream sync                                                                   |
| `ApplicationInsightsAgent_EXTENSION_VERSION` | `disabled`                                                                                                                           | Codeless agent floods logs and slows cold starts                                                                      |
| `FRONTEND_MODE`                              | `skip`                                                                                                                               | No `frontend/` directory in repo; default `serve` crashes during route setup                                          |
| `REDIS_KEY` \_                               | _(Azure Ca_he for Redis primary access key)_                                                                                         | Without it, all Redis commands fail with `NOAUTH Authentication required`                                             |
| `ENTRA_ID_AUTHENTICATION_TYPE`               | `secret`                                                                                                                             | Default `managed-identity` silently skips passport strategy registration → "Unknown authentication strategy entra-id" |
| `ENTRA_ID_AUTHENTICATION_CLIENT_ID`          | = `AAD_CLIENT_ID`                                                                                                                    | Used by passport strategy (separate from `ENTRA_ID_CLIENT_ID`)                                                        |
| `ENTRA_ID_AUTHENTICATION_CLIENT_SECRET`      | = `AAD_CLIENT_SECRET`                                                                                                                |                                                                                                                       |
| `ENTRA_ID_AUTHENTICATION_TENANT_ID`          | = `AAD_TENANT_ID`                                                                                                                    |                                                                                                                       |
| `ENTRA_ID_REDIRECT_URL`                      | `https://dev.portal.github.nih.gov/auth/entra-id/callback` (staging) / `https://portal.github.nih.gov/auth/entra-id/callback` (prod) | Must also be registered as a redirect URI in Entra app registration                                                   |
| `ENTRA_ID_MULTI_TENANT`                      | `1`                                                                                                                                  | Set on NIH App Service; enables multitenant MSAL authority so non-NIH Entra users (e.g. ARPA-H) can sign in           |
| `ENTRA_ID_ALLOWED_TENANT_IDS`                | `{NIH-tenant-id};{ARPA-H-tenant-id}`                                                                                                 | Set on NIH App Service; NIH tenant ID = value of `ENTRA_ID_AUTHENTICATION_TENANT_ID`; semicolon-separated             |

See `AGENTS.md` for the full required-settings table and a known-errors quick-reference.

---

### ARPA-H User Migration Procedure

When a user migrates from an NIH identity (`user@nih.gov`) to an ARPA-H identity (`user@arpa-h.gov`), their `links` row must be updated manually in both databases (`nihdevgithubportal` and `nihgithubportal`).

#### Step 1 — Get the ARPA-H home-tenant OID

```bash
az login --tenant <arpa-h-tenant-id>
az ad user show --id user@arpa-h.gov --query id -o tsv
```

This must be the **ARPA-H home-tenant OID** — not the NIH guest OID. The portal uses `oid` from the MSAL token (issued by the home tenant) as the corporate ID.

#### Step 2 — Update the links row

```sql
UPDATE links
SET corporateid = '<arpa-h-oid>',
    corporateusername = 'user@arpa-h.gov',
    corporatemail = 'user@arpa-h.gov',
    corporatename = 'Display Name (ARPA-H)'
WHERE thirdpartytype = 'github'
  AND lower(thirdpartyusername) = '<github-login-lowercase>';
```

Confirm `UPDATE 1` before proceeding. Run this on both the staging and production databases.

#### Step 3 — Verify the ARPA-H tenant is allowed

Confirm the ARPA-H tenant ID is present in `ENTRA_ID_ALLOWED_TENANT_IDS` on both App Services (semicolon-separated). Without it, the sign-in is rejected before the link lookup runs.

#### Step 4 — Have the user sign in

The user signs in with their ARPA-H identity. No further action is needed — the 30-second Redis links cache expires quickly, and `AddLinkToRequest` queries Postgres directly by `corporateid`.

#### Ongoing: display name staleness

The `refreshUsernames` job keeps NIH users' `corporatename` in sync automatically by calling `graphProvider.getUserById(corporateId)`. For ARPA-H users, the NIH tenant's Graph client cannot resolve the ARPA-H OID, so the job silently skips them. If an ARPA-H user changes their display name (e.g. due to a title/org change within ARPA-H), it must be updated manually:

```sql
UPDATE links
SET corporatename = 'New Display Name'
WHERE thirdpartytype = 'github'
  AND lower(thirdpartyusername) = '<github-login-lowercase>';
```

---

### 1. Add `helmet` middleware (CSP, X-Frame-Options, nosniff, Referrer-Policy)

**Files:** `middleware/index.ts`, `package.json`

The middleware stack currently only sets HSTS and disables `X-Powered-By`. No `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, or `Referrer-Policy` headers are sent. These are the primary browser-side defenses against XSS and clickjacking.

- [ ] `npm install helmet`
- [ ] Register `app.use(helmet({ ... }))` early in `middleware/index.ts`, before routing
- [ ] Define a CSP policy appropriate to the app's asset sources (GitHub, Azure CDN, etc.) — start in report-only mode (`helmet.contentSecurityPolicy({ reportOnly: true })`) to avoid breaking changes, then harden

---

### 2. Add `permissions:` blocks to all workflows

**Files:** `.github/workflows/ci.yml`, `.github/workflows/codeql-analysis.yml`, and any workflow lacking an explicit `permissions:` declaration

Without an explicit `permissions:` block, workflows inherit the repository default (often `write-all` for private repos). A compromised step could push code, publish packages, or modify secrets.

- [ ] Add minimal-privilege `permissions:` at the top level of each workflow:

  ```yaml
  permissions:
    contents: read
  ```

- [ ] For workflows that need additional access (e.g., CodeQL needs `security-events: write`), scope those grants per-job rather than globally

---

## Medium Priority

### 4. Set `sameSite` on the session cookie

**File:** `middleware/session.ts`

There is a 6-year-old `// TODO: 2020: consider SameSite` comment. The session cookie is currently created without an explicit `sameSite` attribute. Setting it explicitly documents intent and provides defense-in-depth against CSRF for the OAuth redirect flows.

- [ ] Add `sameSite: 'lax'` to the `settings.cookie` object in `middleware/session.ts`
- [ ] Verify that `sameSite: 'lax'` is compatible with the Entra ID and GitHub OAuth callback flows (both use `GET` redirects, so `lax` should work)

---

### 5. Add `bun audit` step to CI

**File:** `.github/workflows/ci.yml`

Dependabot PRs can take days; a failing audit step catches known vulnerabilities on every push independently of Dependabot.

- [ ] Add to `ci.yml` after the install step:

  ```yaml
  - name: Audit dependencies
    run: bun audit --audit-level=high
  ```

---

### 6. Add container image vulnerability scanning

**Files:** `.github/workflows/ci.yml` or a new `security-scan.yml`

The Docker build in CI creates an image but never scans it. Both the Azure Linux base layer (OS packages) and the npm layer can contain CVEs that only appear post-build.

- [ ] Add a [Trivy](https://github.com/aquasecurity/trivy-action) step after `docker build`:

  ```yaml
  - name: Scan container image
    uses: aquasecurity/trivy-action@<sha>
    with:
      image-ref: 'portal:latest'
      format: 'table'
      exit-code: '1'
      severity: 'HIGH,CRITICAL'
  ```

- [ ] Alternatively integrate [Grype](https://github.com/anchore/scan-action) for SBOM-aware scanning

---

### 7. Add Dependabot coverage for `frontend/`

**File:** `.github/dependabot.yml`

Dependabot covers `/` and `/default-assets-package` for npm, but the `frontend/` directory has its own `package.json` (referenced in `Dockerfile` as `WORKDIR /build/frontend`) and is not covered.

- [ ] Add a third npm entry to `dependabot.yml`:

  ```yaml
  - package-ecosystem: npm
    directory: /frontend
    target-branch: staging
    schedule:
      interval: daily
    open-pull-requests-limit: 10
    commit-message:
      prefix: 'npm - frontend'
  ```

---

### 8. Verify package integrity in CI (`bun audit`)

**File:** `.github/workflows/ci.yml`

Bun's lockfile uses SHA-512 integrity hashes for every package. Adding `bun audit` in CI catches advisories on every push independently of Dependabot.

- [ ] Add to `ci.yml` after install:

  ```yaml
  - name: Verify package integrity
    run: bun audit
  ```

---

## Lower Priority

### 9. Migrate `staging_create_acr_image.yml` off static registry credentials

**File:** `.github/workflows/staging_create_acr_image.yml`

The staging image push workflow uses `secrets.DEV_REGISTRY_USER` and `secrets.DEV_REGISTRY_PASS` (long-lived static credentials), while `container.yml` correctly uses OIDC (`azure/login` with `client-id`/`tenant-id`/`subscription-id`). Static credentials are a higher-value target and cannot be automatically rotated.

- [ ] Configure a workload identity federated credential for the staging environment in Azure
- [ ] Replace the Docker login step with `azure/login@v2` using OIDC, then `az acr login`
- [ ] Remove `DEV_REGISTRY_USER` and `DEV_REGISTRY_PASS` secrets once migrated

---

### 10. Audit and contain unescaped Pug template expressions

**Files:** `views/error.pug`, `views/contributions/index.pug`

`views/error.pug` uses `!= detailed` (unescaped HTML), which is intentional per an inline comment — but it creates a footgun if any future code path sets `err.detailed` from external (GitHub API, user) data. The `!=` in `views/contributions/index.pug` is for trusted Octicon SVG strings.

- [ ] Audit all `!=` / `!{` occurrences in `views/` and document in a comment next to each why raw HTML is safe at that point
- [ ] Where possible, replace with escaped `=` expressions and pass pre-built HTML through a controlled helper rather than open-ended error properties

---

### 11. Escaping database name in `scripts/postgres/setup.ts`

**File:** `scripts/postgres/setup.ts`

Line 34 interpolates `${db}` directly into a `CREATE DATABASE` query string without using `pg-escape`, while line 43 correctly uses `escape(...)` for user creation. Both should use parameterized or escaped values.

- [ ] Replace `\`create database ${db}\``with`escape('create database %I', db)`using the already-imported`pg-escape` package

---

### 12. Evaluate private npm registry proxy (Azure Artifacts / Artifactory)

Routing all npm installs through an internal registry mirror that scans packages before they are available to developers and CI provides a chokepoint for supply chain attacks independent of public registry health.

- [ ] Evaluate Azure Artifacts Upstream Sources or GitHub Packages as a proxy
- [ ] If adopted, restrict `.npmrc` in the Dockerfile and devcontainer to the internal registry and remove direct registry access

---

### 13. Evaluate Socket.dev or Snyk for proactive dependency analysis

Dependabot and `npm audit` are reactive (known CVEs). [Socket.dev](https://socket.dev) and Snyk both analyze package behavior (network access, filesystem access, install scripts, typosquatting) before a CVE is published.

- [ ] Install the Socket GitHub App on the repository
- [ ] Configure it to block PRs that introduce packages with flagged behaviors

---

## Already in Place (No Action Required)

- `bun install --frozen-lockfile --ignore-scripts` in `Dockerfile` and all CI workflows — prevents malicious install scripts and ensures reproducible installs
- `bun.lock` with SHA-512 integrity hashes for all packages (replaces `package-lock.json`) — deterministic installs
- All GitHub Actions SHA-pinned to exact commit hashes across all 10 workflow files
- `app.disable('x-powered-by')` in `middleware/index.ts`
- HSTS with preload and `includeSubDomains` via `middleware/hsts.ts`
- `eslint-plugin-security` integrated in `eslint.config.mjs`
- OIDC-based Azure auth in `container.yml` (no static Azure credentials)
- Dependabot covering npm (`/`, `/default-assets-package`), GitHub Actions, and Docker
- CodeQL scanning on push and weekly (`codeql-analysis.yml`)
- API token validation via Entra in `middleware/api/authentication/`
- Session production guards (rejects `memory`/`file` providers in production)
- Rate limiting on all API routes (GHAS alerts resolved May 2026)
- Redis v5 auth handled correctly via `createClient({ password })` (fixed May 2026)
