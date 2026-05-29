# AGENTS.md

Notes for AI coding agents working on this repository.

## Dev environment

- **Package manager:** bun only. Never `npm install`. Lockfile: `bun.lock`.
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

| Setting                                      | Value                                                                                                                                | Notes                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `WEBSITE_RUN_FROM_PACKAGE`                   | `1`                                                                                                                                  | Immutable zip mount; prevents stale-file accumulation                                                        |
| `SCM_DO_BUILD_DURING_DEPLOYMENT`             | `false`                                                                                                                              |                                                                                                              |
| `ENABLE_ORYX_BUILD`                          | `false`                                                                                                                              |                                                                                                              |
| Startup Command                              | `node /home/site/wwwroot/github-portal/dist/bin/www`                                                                                 | General settings tab                                                                                         |
| `ApplicationInsightsAgent_EXTENSION_VERSION` | `disabled`                                                                                                                           | Prevents codeless agent log flood                                                                            |
| `AUTHENTICATION_SCHEME`                      | `entra-id`                                                                                                                           | `aad` throws on startup since upstream sync                                                                  |
| `ENTRA_ID_CLIENT_ID`                         | = `AAD_CLIENT_ID`                                                                                                                    | Upstream renamed AAD*\* → ENTRA*\*                                                                           |
| `ENTRA_ID_CLIENT_SECRET`                     | = `AAD_CLIENT_SECRET`                                                                                                                |                                                                                                              |
| `ENTRA_ID_TENANT_ID`                         | = `AAD_TENANT_ID`                                                                                                                    |                                                                                                              |
| `ENTRA_ID_AUTHENTICATION_TYPE`               | `secret`                                                                                                                             | Default `managed-identity` silently skips strategy registration → "Unknown authentication strategy entra-id" |
| `ENTRA_ID_AUTHENTICATION_CLIENT_ID`          | = `AAD_CLIENT_ID`                                                                                                                    | Used by passport strategy, distinct from ENTRA_ID_CLIENT_ID                                                  |
| `ENTRA_ID_AUTHENTICATION_CLIENT_SECRET`      | = `AAD_CLIENT_SECRET`                                                                                                                |                                                                                                              |
| `ENTRA_ID_AUTHENTICATION_TENANT_ID`          | = `AAD_TENANT_ID`                                                                                                                    |                                                                                                              |
| `ENTRA_ID_REDIRECT_URL`                      | `https://dev.portal.github.nih.gov/auth/entra-id/callback` (staging) / `https://portal.github.nih.gov/auth/entra-id/callback` (prod) | Must also be registered in Entra app registration                                                            |
| `FRONTEND_MODE`                              | `skip`                                                                                                                               | No `frontend/` directory in repo; default `serve` crashes on startup                                         |
| `REDIS_KEY`                                  | _(Redis access key)_                                                                                                                 | Azure Cache for Redis → Access keys → Primary                                                                |

Keep old `AAD_*` settings — `AAD_ISSUER`, `AAD_BLOCK_GUESTS`, `AAD_BLOCK_GUEST_LINKING`, `AAD_MULTI_TENANT` are still read by other config paths.

## Known startup errors → fix

| Error in log                                                          | Fix                                                                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `SyntaxError: does not provide an export named 'createTracingClient'` | Stale npm `node_modules` under Kudu additive deploy. Fix: `WEBSITE_RUN_FROM_PACKAGE=1`. See PLAN.md §0. |
| `No Entra application configuration found`                            | Add `ENTRA_ID_CLIENT_ID/SECRET/TENANT_ID` app settings.                                                 |
| `AAD is no longer supported`                                          | Set `AUTHENTICATION_SCHEME=entra-id`.                                                                   |
| `Unknown authentication strategy "entra-id"`                          | Set `ENTRA_ID_AUTHENTICATION_TYPE=secret` and the `ENTRA_ID_AUTHENTICATION_*` vars above.               |
| `The static-react-folder…does not exist: …/frontend`                  | Set `FRONTEND_MODE=skip`.                                                                               |
| `NOAUTH Authentication required` (Redis)                              | Set `REDIS_KEY` to the Redis access key.                                                                |
