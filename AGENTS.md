# AGENTS.md

Notes for AI coding agents (and humans debugging at 2 AM) working on this repository.

---

## 🚨 If production (`nihgithubportal`) is crash-looping after a `main` deploy — start here

### Symptom

The Azure App Service log shows this on every cold start, in an infinite restart loop:

```text
file:///home/site/wwwroot/github-portal/node_modules/@azure/storage-blob/dist/esm/utils/tracing.js:3
import { createTracingClient } from "@azure/core-tracing";
         ^^^^^^^^^^^^^^^^^^^
SyntaxError: The requested module '@azure/core-tracing' does not provide an export named 'createTracingClient'
    at #asyncInstantiate (node:internal/modules/esm/module_job:326:21)
```

…or a similar SyntaxError about a named export missing from an `@azure/*` package.

### Do NOT do these things (they will not fix it)

These were tried, in order, on `nihdevgithubportal` and **none of them worked**:

1. ❌ Shipping `node_modules.tar.gz` at the root of the zip for Oryx to extract.
2. ❌ Including `github-portal/node_modules/` in the zip so Kudu "overwrites" the old files.
3. ❌ Bumping `@azure/*` package versions.
4. ❌ Switching package managers (npm ↔ bun).
5. ❌ Re-running the deploy.

The reason none of these work is explained below.

### Why it crashes (the real root cause)

**Kudu zip deploy is additive.** It overlays files from the new zip on top of whatever already exists in `/home/site/wwwroot` — it never deletes files that aren't in the new zip.

The very first deployment to this App Service used `npm install`, which created a deeply nested layout including (for example):

```text
/home/site/wwwroot/github-portal/node_modules/@azure/storage-blob/node_modules/@azure/core-tracing/  ← version 1.0.0-preview.11
/home/site/wwwroot/github-portal/node_modules/@azure/core-http/node_modules/@azure/core-tracing/    ← version 1.0.0-preview.11
```

That preview version is CJS-only and does **not** export `createTracingClient`.

Subsequent deploys use `bun install`, which produces a **flat / hoisted** layout — packages are at the top level, with very little nesting. Bun never writes files at the nested paths above, so **Kudu has no new files to overwrite the stale ones with**. They persist forever.

When Node.js resolves `import "@azure/core-tracing"` from inside `@azure/storage-blob`, it walks up the directory tree:

1. `…/storage-blob/node_modules/@azure/core-tracing/` ✅ **found** — the OLD `1.0.0-preview.11` left behind by npm
2. `…/github-portal/node_modules/@azure/core-tracing/` (the correct `1.3.1`, never reached)

Result: the legacy preview package wins, the ESM import fails, the app crashes, App Service restarts it, repeat forever.

### The fix — `WEBSITE_RUN_FROM_PACKAGE=1`

Switch the App Service to Azure's run-from-package deployment model. The zip is mounted **read-only and immutable** at `/home/site/wwwroot` on every cold start. There is no persistent filesystem to accumulate stale files. Every deploy is a complete, atomic state. This is also Azure's recommended pattern for Node.js apps.

#### Azure portal steps (App Service → `nihgithubportal` → Configuration)

| Setting                            | Value                                                |
| ---------------------------------- | ---------------------------------------------------- |
| Application settings               |                                                      |
| `WEBSITE_RUN_FROM_PACKAGE`         | `1`                                                  |
| `SCM_DO_BUILD_DURING_DEPLOYMENT`   | `false`                                              |
| `ENABLE_ORYX_BUILD`                | `false`                                              |
| General settings → Startup Command | `node /home/site/wwwroot/github-portal/dist/bin/www` |

#### Azure CLI equivalent

```bash
az webapp config appsettings set --name nihgithubportal --resource-group <RG> \
  --settings WEBSITE_RUN_FROM_PACKAGE=1 SCM_DO_BUILD_DURING_DEPLOYMENT=false ENABLE_ORYX_BUILD=false
az webapp config set --name nihgithubportal --resource-group <RG> \
  --startup-file "node /home/site/wwwroot/github-portal/dist/bin/www"
```

#### Workflow change (`.github/workflows/main_nihgithubportal.yml`)

Mirror what was done in `staging_nihdevgithubportal.yml` (see git history of that file):

1. Build a zip with `github-portal/` as the root entry, containing `dist/`, `node_modules/`, etc.
2. Strip `*.map` and `*.d.ts` from `node_modules` to keep the artifact small.
3. Pass the zip directly to `azure/webapps-deploy` via `package: node-app.zip` — do not let the action re-zip a directory.
4. Delete any `node_modules.tar.gz` / Oryx-related steps — with run-from-package, Oryx is fully bypassed.

#### Caveat — read-only `wwwroot`

With `WEBSITE_RUN_FROM_PACKAGE=1`, the app **cannot write to `/home/site/wwwroot`**. Anything writable must live under `/home/` (the persistent share, which is mounted separately from `wwwroot`). Audit any code that writes to its own directory (logs, uploads, caches) before flipping the switch in production.

### Reference

- The same fix was applied to `staging` in commit `a86a31d3` ("deploy: switch to `WEBSITE_RUN_FROM_PACKAGE=1` for immutable wwwroot").
- See also: `PLAN.md` → "When `staging` merges to `main`: apply `WEBSITE_RUN_FROM_PACKAGE=1` to production".

---

## 🚨 If the app starts but immediately throws "No Entra application configuration found"

### Error message

The App Service log shows the app binding to port 8080 and then dying:

```text
startup development mode: HTTP: listening, HSTS: off
Startup error: Error: No Entra application configuration found in activeDirectory.application
```

### Root cause

The upstream sync (commit `55c10cfe`) restructured `config/activeDirectory.json` and renamed all
app-registration env vars from `AAD_*` to `ENTRA_*`. The App Service still has only the old names.
The config resolver looks for `ENTRA_ID_CLIENT_ID` etc., finds nothing, and throws.

### Fix — add the new env var names alongside the old ones

In **Azure portal → App Service → Configuration → Application settings**, add:

| New setting name         | Copy value from     |
| ------------------------ | ------------------- |
| `ENTRA_ID_CLIENT_ID`     | `AAD_CLIENT_ID`     |
| `ENTRA_ID_CLIENT_SECRET` | `AAD_CLIENT_SECRET` |
| `ENTRA_ID_TENANT_ID`     | `AAD_TENANT_ID`     |

**Do NOT rename or delete the old `AAD_*` settings.** Other parts of the config still reference
`AAD_ISSUER`, `AAD_BLOCK_GUESTS`, `AAD_BLOCK_GUEST_LINKING`, `AAD_MULTI_TENANT`, etc. Both sets
must coexist.

Save → app restarts → should load cleanly.

---

## General notes for agents working in this repo

- **Package manager: bun.** Never run `npm install`. Use `bun install --frozen-lockfile --ignore-scripts`. The lockfile is `bun.lock`, not `package-lock.json`.
- **Node.js: 24.x** (matches Azure App Service runtime). Don't downgrade.
- **Tests: vitest via `bun test`.** Do not run `npm test`.
- **CI / lint commands** (also enforced by the pre-push hook):
  - `bun run lint:md`
  - `bun run lint:js`
  - `bun run lint:spell`
- **Prettier** is enforced by ESLint. Run `bunx prettier --write <files>` before committing if you've edited many files.
- **cSpell** allowlist lives in `.cspell.json`. If CI flags a real word that's not a typo, add it there.
- **SAML SSO on the NIHGOV org** requires `unset GITHUB_TOKEN && gh auth setup-git` before `git push`. The git credential helper otherwise sends a token that the org rejects.
- **Deploy workflows:**
  - `staging` branch → `staging_nihdevgithubportal.yml` → `nihdevgithubportal` (uses `WEBSITE_RUN_FROM_PACKAGE=1`).
  - `main` branch → `main_nihgithubportal.yml` → `nihgithubportal` (will need the same migration — see above).
