# Security Improvement Plan

Priority-ordered list of security improvements identified across this repository.

---

## Completed (May 2026 — GitHub Copilot agentic session)

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
| `github/codeql-action`      | v3          | `03e4368a` (v3)       |
| `ruby/setup-ruby`           | v1.127.0    | `ee211353` (v1.127.0) |
| `azure/postgresql`          | v1          | `59401b78` (v1)       |

### ✅ Upgraded `applicationinsights` 2.9.8 → 3.15.0 (OpenTelemetry)

Fixes `DEP0005` (`Buffer()`) and `DEP0169` (`url.parse()`) deprecation warnings on Node.js 24. Breaking API changes addressed:

- `lib/mail/render.ts` + `render.test.ts` — replaced `import type NodeClient from 'applicationinsights/out/Library/NodeClient.js'` (internal v2 path, broken in v3) with `import type { TelemetryClient } from 'applicationinsights'`
- `middleware/appInsights.ts` — removed `wrapWithCorrelationContext` / `getCorrelationContext` / `startOperation` (v2 correlation model removed; v3 propagates context automatically via OpenTelemetry async hooks); removed deprecated `instrumentationKey` reference

---

## High Priority

### 0. **When `staging` merges to `main`: apply `WEBSITE_RUN_FROM_PACKAGE=1` to production**

**Background — read this first if production is crash-looping after the merge.**

The staging deploy workflow (`.github/workflows/staging_nihdevgithubportal.yml`) was switched to Azure's run-from-package deployment model to fix a persistent crash loop on `nihdevgithubportal`. The production workflow (`.github/workflows/main_nihgithubportal.yml`) and the production App Service (`nihgithubportal`) still use the legacy Kudu additive zip deploy and **will hit the exact same crash the first time `main` is updated with the bun-based deploy artifact.**

**The crash (for context):**

```text
SyntaxError: The requested module '@azure/core-tracing' does not provide an export named 'createTracingClient'
  at file:///home/site/wwwroot/github-portal/node_modules/@azure/storage-blob/dist/esm/utils/tracing.js:3
```

**Root cause:** Kudu zip deploy is _additive_ — it only overlays files and never deletes anything. The original npm-based deployment left deeply nested copies of `@azure/core-tracing@1.0.0-preview.11` (legacy CJS preview, no `createTracingClient` export) under sibling `@azure/*` packages' own `node_modules/` directories. Our bun-installed layout hoists flat and never writes files at those nested paths, so Kudu has nothing to overwrite them with. Node.js resolution from `@azure/storage-blob` walks up and finds the OLD nested copy before reaching our correct `@azure/core-tracing@1.3.1`. **No amount of file-shipping fixes this** — the persistent `wwwroot` keeps accumulating cruft from every previous deploy forever.

**Fix:** switch the production App Service to `WEBSITE_RUN_FROM_PACKAGE=1`. The zip is mounted _read-only and immutable_ at `/home/site/wwwroot` on every cold start, so there is no persistent filesystem to accumulate stale files. Every deploy is a complete, atomic state.

#### Production App Service settings to add (one-time, in Azure portal → `nihgithubportal` → Configuration)

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

#### Workflow changes needed (mirror what was done to `staging_nihdevgithubportal.yml`)

- [ ] Drop the `output.tar.gz` step and the "Unpack tar" step — produce a zip with `github-portal/` as the root entry containing `dist/`, `node_modules/`, etc.
- [ ] Strip `*.map` and `*.d.ts` from `node_modules` to keep the zip small (~200 MB savings).
- [ ] Pass the zip directly to `azure/webapps-deploy` via `package: node-app.zip` (no re-zipping by the action).
- [ ] Remove any `node_modules.tar.gz` Oryx hack if present — with run-from-package, Oryx is fully bypassed.

#### Caveat — read-only `wwwroot`

With `WEBSITE_RUN_FROM_PACKAGE=1`, the app **cannot write to `/home/site/wwwroot`**. Anything writable must live under `/home/` (the persistent share, separate from `wwwroot`). Audit any code that writes to its own directory (logs, uploads, caches) before flipping the switch in production.

See `AGENTS.md` for the debugging checklist if the production app crash-loops with this error after the staging→main merge.

#### Also add the renamed Entra env vars to `nihgithubportal`

The upstream sync (commit `55c10cfe`) completely restructured `config/activeDirectory.json`, renaming all app registration env vars from `AAD_*` to `ENTRA_*`. Production still has the old names. Add the new names **alongside** the old ones (do not rename — other config paths still reference `AAD_ISSUER`, `AAD_BLOCK_GUESTS`, etc.):

| Add this new setting     | Copy value from     |
| ------------------------ | ------------------- |
| `ENTRA_ID_CLIENT_ID`     | `AAD_CLIENT_ID`     |
| `ENTRA_ID_CLIENT_SECRET` | `AAD_CLIENT_SECRET` |
| `ENTRA_ID_TENANT_ID`     | `AAD_TENANT_ID`     |

Without these, the app starts and binds to port 8080 but immediately throws:

```text
Startup error: Error: No Entra application configuration found in activeDirectory.application
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
