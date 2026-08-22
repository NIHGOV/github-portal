# AGENTS.md

Notes for AI coding agents working on this repository.

## Dev environment

- **Package manager:** bun only. Never `npm install`. Lockfile: `bun.lock`.
- **Before committing:** Update `PLAN.md` with a summary of any fix or change made in that commit.
- **Node:** 24.x. Do not downgrade.
- **Tests:** `bun run test` (vitest). Not `bun test` (that's Bun's native runner — incompatible). Not `npm test`.
- **Lint** (also enforced by pre-push hook): `bun run lint:md && bun run lint:js && bun run lint:spell`
- **Prettier** enforced via ESLint. Run `bunx prettier --write <files>` after large edits.
- **cSpell** allowlist: `.cspell.json`. Add real words that CI flags.
- **SAML SSO push:** `unset GITHUB_TOKEN && gh auth setup-git` before `git push` to NIHGOV.

## Deploy workflows

- `staging` → `staging_nihdevgithubportal.yml` → `nihdevgithubportal` (`WEBSITE_RUN_FROM_PACKAGE=1`)
- `main` → `main_nihgithubportal.yml` → `nihgithubportal` (needs same migration — see PLAN.md §0)

## Required App Service settings

All settings apply to both `nihdevgithubportal` and `nihgithubportal` unless noted.

| Setting                                      | Value                                                                                                                                | Notes                                                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `WEBSITE_RUN_FROM_PACKAGE`                   | `1`                                                                                                                                  | Immutable zip mount; prevents stale-file accumulation                                                                                 |
| `SCM_DO_BUILD_DURING_DEPLOYMENT`             | `false`                                                                                                                              |                                                                                                                                       |
| `ENABLE_ORYX_BUILD`                          | `false`                                                                                                                              |                                                                                                                                       |
| Startup Command                              | `node /home/site/wwwroot/github-portal/dist/bin/www`                                                                                 | General settings tab                                                                                                                  |
| `ApplicationInsightsAgent_EXTENSION_VERSION` | `disabled`                                                                                                                           | Prevents codeless agent log flood                                                                                                     |
| `AUTHENTICATION_SCHEME`                      | `entra-id`                                                                                                                           | `aad` throws on startup since upstream sync                                                                                           |
| `ENTRA_ID_CLIENT_ID`                         | = `AAD_CLIENT_ID`                                                                                                                    | Upstream renamed AAD*\* → ENTRA*\*                                                                                                    |
| `ENTRA_ID_CLIENT_SECRET`                     | = `AAD_CLIENT_SECRET`                                                                                                                |                                                                                                                                       |
| `ENTRA_ID_TENANT_ID`                         | = `AAD_TENANT_ID`                                                                                                                    |                                                                                                                                       |
| `ENTRA_ID_AUTHENTICATION_TYPE`               | `secret`                                                                                                                             | Default `managed-identity` silently skips strategy registration → "Unknown authentication strategy entra-id"                          |
| `ENTRA_ID_AUTHENTICATION_CLIENT_ID`          | = `AAD_CLIENT_ID`                                                                                                                    | Used by passport strategy, distinct from ENTRA_ID_CLIENT_ID                                                                           |
| `ENTRA_ID_AUTHENTICATION_CLIENT_SECRET`      | = `AAD_CLIENT_SECRET`                                                                                                                |                                                                                                                                       |
| `ENTRA_ID_AUTHENTICATION_TENANT_ID`          | = `AAD_TENANT_ID`                                                                                                                    |                                                                                                                                       |
| `ENTRA_ID_REDIRECT_URL`                      | `https://dev.portal.github.nih.gov/auth/entra-id/callback` (staging) / `https://portal.github.nih.gov/auth/entra-id/callback` (prod) | Must also be registered in Entra app registration                                                                                     |
| `ENTRA_ID_MULTI_TENANT`                      | `1`                                                                                                                                  | Set on NIH App Service; enables multitenant MSAL authority so non-NIH Entra users (e.g. ARPA-H) can sign in                           |
| `ENTRA_ID_ALLOWED_TENANT_IDS`                | `{NIH-tenant-id};{ARPA-H-tenant-id}`                                                                                                 | Set on NIH App Service; NIH tenant ID = value of `ENTRA_ID_AUTHENTICATION_TENANT_ID`; semicolon-separated                             |
| `FRONTEND_MODE`                              | `skip`                                                                                                                               | No `frontend/` directory in repo; default `serve` crashes on startup                                                                  |
| `REDIS_KEY`                                  | _(Redis access key)_                                                                                                                 | Azure Cache for Redis → Access keys → Primary                                                                                         |
| `GITHUB_APP_OPERATIONS_SLUG`                 | GitHub App slug for the operations app (e.g. `dev-nih-github-management-portal` on staging)                                          | Must match the actual slug shown at `github.com/organizations/NIHGOV/settings/apps/…`; used for install links and bot-login detection |
| `IS_CONTAINER_DEPLOYMENT`                    | `1`                                                                                                                                  | Enables Express `trust proxy`; required so `req.protocol` = `https` (reads `x-forwarded-proto`). Without it, POST forms return 403.   |

Keep old `AAD_*` settings — `AAD_ISSUER`, `AAD_BLOCK_GUESTS`, `AAD_BLOCK_GUEST_LINKING`, `AAD_MULTI_TENANT` are still read by other config paths.

**`DEBUG` setting:** Do not set this (or leave blank) on either App Service. If set to a broad pattern (e.g. `*`), the `debug` module sends router/body-parser/express-session traces to stderr, which appears in Azure's ERROR log stream and makes real errors hard to find.

**Production workflow migration done:** `main_nihgithubportal.yml` now uses the same zip + `WEBSITE_RUN_FROM_PACKAGE=1` model as staging. Before the first deploy from `main`, apply the one-time App Service settings in PLAN.md §0.

## Known startup errors → fix

| Error in log                                                          | Fix                                                                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `SyntaxError: does not provide an export named 'createTracingClient'` | Stale npm `node_modules` under Kudu additive deploy. Fix: `WEBSITE_RUN_FROM_PACKAGE=1`. See PLAN.md §0. |
| `No Entra application configuration found`                            | Add `ENTRA_ID_CLIENT_ID/SECRET/TENANT_ID` app settings.                                                 |
| `AAD is no longer supported`                                          | Set `AUTHENTICATION_SCHEME=entra-id`.                                                                   |
| `Unknown authentication strategy "entra-id"`                          | Set `ENTRA_ID_AUTHENTICATION_TYPE=secret` and the `ENTRA_ID_AUTHENTICATION_*` vars above.               |
| `The static-react-folder…does not exist: …/frontend`                  | Set `FRONTEND_MODE=skip`.                                                                               |
| `NOAUTH Authentication required` (Redis)                              | Set `REDIS_KEY` to the Redis access key.                                                                |
| All POST forms return HTTP 403 "Invalid request origin"               | Set `IS_CONTAINER_DEPLOYMENT=1`; enables `trust proxy` so CSRF origin check passes.                     |
