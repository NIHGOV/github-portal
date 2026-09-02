# Security Improvement Plan

Priority-ordered list of security improvements identified across this repository.

---

## Link audit report: Org People "linked" cache vs. live Postgres (September 2026)

- **Root cause investigated**: accounts that link via Entra ID MTO (multi-tenant, external-tenant
  domain) sign-ins can show as linked to themselves (`middleware/business/links.ts`'s
  `tryAddLinkToRequest` does a live `queryByCorporateId` lookup) while still showing "Not linked" in
  the Org People view, which instead matches against `operations.getLinks()`'s 30-second Redis-cached
  bulk snapshot of the `links` table keyed by GitHub `thirdpartyid`. A genuinely persistent (not just
  briefly stale) mismatch points at a real discrepancy between that cache and the live table.
- Added `business/operations/linkAudit.ts` (`auditLinks()`): for a set of GitHub orgs, compares each
  member's cached link (`operations.getLinks()`) against a direct, uncached `linkProvider.getAll()`
  read, flagging `stale-cache` (row exists live but missing from cache), `orphaned-cache` (opposite),
  and `linked-no-corporate-username` (linked but shown as an "unknown account").
- Added `scripts/linkAudit.ts`, a `job.run`-based CLI wrapper (env: `LINK_AUDIT_GITHUB_ORGS`,
  optional `LINK_AUDIT_FRESH_MEMBERS`), consistent with the `scripts/tenantMigration/` scripts.
- Exposed the same report as a self-service admin page: `GET /administration/link-audit` (CSV,
  optional `?orgs=` query param, defaults to all configured orgs) in `routes/administration/index.ts`,
  already gated by the existing `AuthorizeOnlyCorporateAdministrators` middleware on `/administration`.
  Added a "Link audit (cache vs. live)" entry to `views/administration/menu.pug`.

---

## Added Redis `pingInterval` to reduce idle-disconnect noise (September 2026)

Firehose logs were constantly showing `startup cache Redis client error: Socket closed
unexpectedly`. Not a regression of the August 2026 crash-loop fix — that fix's `.on('error', ...)`
listener was working as intended (logging instead of crashing), but the firehose container only
touches Redis when a Service Bus message arrives, so the connection sits idle between events and
gets closed by Azure Cache for Redis's idle-connection timeout, triggering the error + a reconnect
each time. `middleware/initialize.ts` already had an unused, dead-code duplicate `connectRedis()`
with a `pingInterval: 5 * 60 * 1000` (per Azure's idle-timeout best practices), but nothing calls
it — both cache and session clients go through the shared `connectRedis()` in `middleware/redis.ts`,
which had no `pingInterval`. Added the same 5-minute `pingInterval` there to keep idle connections
alive and cut down on the disconnect/reconnect noise.

---

## Firehose now refreshes `/repos` "Recent" sort in real time (August 2026)

- **Root cause**: the `/repos` "Recent" sort (`sortByPushed` in `business/repoSearch.ts`) sorts on the
  `pushed_at` field cached by `queryCache`, which was only ever refreshed by the slow, staggered
  `jobs/refreshQueryCache.ts` batch job (up to 48 hours per full pass) or by the `repository` webhook
  event (created/edited/renamed/archived/etc). There was no handler for the GitHub `push` event at all,
  so a real push never updated the cache until the next batch pass touched that org — explaining
  inconsistent "N hours ago" staleness across repos.
- Added `business/webhooks/tasks/push.ts`, a new webhook task that calls
  `queryCache.addOrUpdateRepository` with the push event's repository payload, and registered it in
  `business/webhooks/tasks/index.ts`.
- Discovered a second, more fundamental gap in `jobs/firehose.ts`: push events have no `action` field
  and are almost always sent with `sender.type === 'User'`, so they were being silently dropped by the
  generic "ignore non-created/transferred user-sender events" filter before ever reaching the task
  list. Added `'push'` to `EVENTS_TO_ALWAYS_HANDLE` so push events bypass that filter.
- Also documented in `AGENTS.md` to use `bunx` instead of `npx` for one-off package execution.
- **Follow-up fixes from PR review** (Copilot code review on #1195): `push.ts` was gating the cache
  call on `queryCache.supportsOrganizationMembership` instead of `supportsRepositories` — those two
  capabilities are backed by independent providers (`organizationMemberCacheProvider` vs.
  `repositoryCacheProvider`), so a deployment with repo caching enabled but membership caching disabled
  would silently skip every push refresh. Fixed to check `supportsRepositories`. Also,
  `queryCache.addOrUpdateRepository`'s update predicate only compared `updated_at`, so a push with a new
  `pushed_at` but unchanged `updated_at` was a silent no-op that defeated the whole point of this change;
  added a `pushed_at` comparison to the update predicate in `business/queryCache.ts`.
- **Second round of PR review follow-ups**: concurrent firehose threads (and the periodic
  `refreshQueryCache` job racing a webhook) could deliver an older push payload after a newer one, and
  the `pushed_at` inequality check would happily overwrite the cache with the older timestamp, moving
  Recent sort backwards. Added a monotonic guard in `addOrUpdateRepository` that preserves the cached
  `pushed_at` whenever an incoming payload's `pushed_at` is older. Separately, the dependency bump of
  `c3` to `0.7.20` (pulling in `d3@5.16.0`) broke `default-assets-package`'s Grunt build: d3 5 moved its
  minified bundle from the package root to `dist/d3.min.js`, but `Gruntfile.js`'s `copy:d3` task still
  pointed at the old root path. Fixed the `cwd` and verified with a clean
  `bun install --frozen-lockfile && bun run build`.
- **Hardened the monotonic guard further**: it only protected against an older-but-present `pushed_at`,
  so a malformed/partial payload with `pushed_at` missing entirely would still overwrite the cache with
  `undefined`, discarding a previously known-good value. `addOrUpdateRepository` now also preserves the
  cached `pushed_at` whenever the incoming payload's `pushed_at` is falsy.
- **Closed the remaining read-modify-write race**: the monotonic guard compared against a snapshot read
  at the start of the call, so two concurrent callers (e.g. multiple firehose threads processing push
  events for the same repository) could both read the same stale value and race each other on the write,
  letting an older payload win if it wrote last. Added a per-repository async lock in `QueryCache` so all
  `addOrUpdateRepository` calls for a given repository within a process now execute strictly serially,
  eliminating the same-process race the reviewer flagged. A true cross-process guarantee (e.g. against
  the separate `refreshQueryCache` job process) would require an atomic conditional write at the storage
  layer — a larger change to the shared entity metadata abstraction used by many other callers, out of
  scope here.
- **Covered repository deletes with the same lock**: `removeRepository` read-modify-wrote the cache
  independently of `addOrUpdateRepository`'s new lock, so a delete could still interleave with a
  concurrent create/update for the same repository within a process. `removeRepository` now shares the
  same per-repository lock. Note this doesn't solve the separate, deeper issue of a delayed/stale push
  event arriving _after_ a delete has already fully completed — that's an event-ordering/tombstoning
  problem, not a concurrency race, and would need the cache to track deletion state rather than just
  lock ordering; left as a known limitation.

---

## Fix Dependabot/bun lockfile mismatch blocking all open dependency PRs (August 2026)

- **Root cause of all 11 open Dependabot PRs failing CI**: `.github/dependabot.yml` used
  `package-ecosystem: npm` for `/` and `/default-assets-package`, but the project migrated to
  `bun.lock` (frozen-lockfile enforced in `Dockerfile`) months ago. Dependabot kept regenerating/
  editing npm-format `package-lock.json` files that the Docker build never reads, so
  `bun install --frozen-lockfile` failed every time with "lockfile had changes, but lockfile is
  frozen" — unrelated to whatever dependency was actually being bumped.
- Switched both entries in `.github/dependabot.yml` from `package-ecosystem: npm` to
  `package-ecosystem: bun` (GitHub Dependabot has supported `bun.lock` natively since Bun 1.1.39) so
  future PRs update `bun.lock` directly and stay in sync with `package.json`.
- Removed the stale, still-tracked `default-assets-package/package-lock.json` (root's equivalent
  file was already deleted in the original bun migration; this one was left behind). Verified
  `default-assets-package/bun.lock` is currently in sync with `package.json` via
  `bun install --frozen-lockfile --dry-run` before removing it.
- Confirmed `default-assets-package` is not dead code before considering removal — it's the active
  fallback static-assets package (`middleware/staticSiteAssets.ts`) serving favicon/CSS/JS unless
  `static-site-assets-package-name` is overridden in `package.json`, which it isn't.
- The 11 already-open Dependabot PRs (#1073–#1173) were opened under the old npm ecosystem config
  and still lack a matching `bun.lock` update; they need to be closed so Dependabot recreates them
  correctly under the new `bun` ecosystem, or manually patched with a regenerated `bun.lock` per PR.

---

## Log Analytics wiring, Service Bus webhook fix, and log redaction (August 2026)

- **Fixed a real webhook-delivery gap**: the `nihdevgithubportal`/`nihgithubportalevents` Logic
  App (the sole GitHub → Service Bus publishing path per `docs/webhooks.md`) was still wired to the
  pre-migration Service Bus namespace's `events` queue via its `servicebus` API connection —
  firehose moved to the new `nihdevgithubportalsb`/`nihgithubportalsb` namespace during the June
  2026 managed-identity migration, but this connection was never repointed. Confirmed via matching
  `X-Ms-Workflow-Id`/`X-Ms-Workflow-Run-Id` headers from a live GitHub webhook delivery against the
  Logic App's run history. Dev's orphaned queue had accumulated 58 active + 1198 dead-lettered
  messages; prod had 620 active. Fixed by adding a send-only
  `azurerm_servicebus_queue_authorization_rule` on the existing `events` queue and importing the
  pre-existing `servicebus` connection so Terraform can repoint its connection string, without
  touching the Logic App's own definition — `infra/terraform/{dev,prod}/main.tf`. Also fixed a
  `managed_api_id` region mismatch (dev's connection was created in `centralus`, not `eastus`) that
  was forcing an unwanted destroy/recreate instead of an in-place update. Since Azure never returns
  the secure `connectionString` on refresh, added `lifecycle { ignore_changes = [parameter_values] }`
  on dev (already repointed and verified via a clean `plan`) once confirmed; prod's is deferred to a
  follow-up commit until after its own first repoint apply, so the initial value actually gets set.
- **Wired Log Analytics into every other Azure resource** that wasn't already covered (App Service,
  PostgreSQL Flexible Server, Redis Cache, Container Registry, and the Terraform-managed Service Bus
  namespace) via `azurerm_monitor_diagnostic_setting`, referencing the existing resources through
  data sources rather than importing/managing them — `infra/terraform/{dev,prod}/main.tf`.
- **Stopped echoing the tenant-migration container's raw log to the public `tenant_migration.yml`
  job log entirely.** An initial per-line `sed` redaction pass (scrubbing GUIDs, emails,
  corporate-identity snapshot lines, drift-comparison details, and validation-error messages) turned
  out to be fundamentally unsound: free-form corporate-identity values can contain literal newlines,
  which defeats any line-oriented pattern. `container.log` is still written to disk for the
  candidate-extraction step; nothing from the container's stdout is printed publicly anymore.
- Made the tenant-migration container's Log Analytics workspace lookup **fail fast** instead of
  silently launching with no diagnostics sink on failure — since the raw log is no longer echoed
  anywhere, Log Analytics was the only remaining place a failed run's output could be inspected, so
  a silent lookup failure meant a patch-mode failure left nothing recoverable but an exit code.
- Fixed a real Bash syntax bug in the `import_address` validation regex (an unescaped apostrophe
  inside an unquoted `=~` pattern opened an unterminated single-quoted string), which broke every
  `terraform import` dispatch before it could run; verified the fix locally against both a valid
  address and an injection attempt.
- Fixed a misleading `environment: name: 'Production'` label on `staging_nihdevgithubportal.yml`
  (the dev app deploy workflow) — copy-pasted from the real prod deploy workflow without renaming,
  even though it deploys `nihdevgithubportal`. Renamed to `'Development'`; required an accompanying
  Entra ID federated-credential update since this workflow's OIDC trust is bound to the GitHub
  environment name, not just the branch ref (a real functional dependency, not just cosmetic).
- Fixed both app deploy workflows' `environment.url` pointing at the raw
  `azurewebsites.net` hostname (`azure/webapps-deploy`'s output) instead of the actual public custom
  domain (`dev.portal.github.nih.gov` / `portal.github.nih.gov`).
- Added a `terraform import` action (plus masked/validated `import_address`/`import_resource_id`
  inputs, passed as env vars rather than interpolated into the script) to both Terraform workflows,
  so `terraform import` can be run entirely through Actions instead of requiring local/Cloud Shell
  access.
- Bumped `hashicorp/setup-terraform` to v4.0.1 (native Node 24, drops the Node 20 deprecation
  warning).
- Added a "this repo is public" note to `AGENTS.md` — code, commits, Actions logs, issues, and PRs
  are all world-readable; flag anything that would leak credentials/PII/infra details before
  proceeding.
- Separately: Azure Portal's federated-credential UI started defaulting to "immutable" (org-ID/
  repo-ID-based) OIDC subjects that GitHub Actions doesn't send by default, breaking Azure login for
  any credential created through the Portal's default template in the last ~week
  ([Azure/login#617](https://github.com/Azure/login/issues/617)). Fixed by enabling "Use immutable
  subject claim" under this repo's Settings → Actions → OIDC and updating the affected federated
  credentials to match; verified across all four distinct (app, subject) pairings used across the
  repo's workflows (dev/prod × ref-based/environment-based).
- PR #1171 merged to `main` (2026-08-24): prod's push-triggered `Terraform Apply` ran for the
  first time, repointing `azurerm_api_connection.servicebus` (destroy + recreate, same resource ID,
  `Apply complete! Resources: 7 added, 0 changed, 1 destroyed.`) and the app deploy succeeded.
  Added the deferred `lifecycle { ignore_changes = [parameter_values] }` to
  `infra/terraform/prod/main.tf` now that the initial value is set, matching dev, so future plans
  don't see the secure `connectionString` as drifted and force-replace the connection again.

---

## Fixed missing Log Analytics wiring for `nihgithubportalcb` (August 2026)

Azure Portal's Monitoring > Logs showed the Log Analytics workspace for `nihgithubportalfh` but
not `nihgithubportalcb`. Not a Terraform difference — Terraform doesn't manage the container
groups at all (they're created imperatively via `az container create` in GitHub Actions); it only
provisions the shared Log Analytics workspace, Service Bus namespace/queue, and the
`nihgithubportal-firehose` identity. The gap was in `.github/workflows/main_create_acr_image.yml`
(the workflow that auto-deploys on every push to `main`): its `deploy-fh` job looked up
`LA_WORKSPACE_ID`/`LA_WORKSPACE_KEY` and passed `--log-analytics-workspace`/
`--log-analytics-workspace-key` to `az container create`, but `deploy-cb` never did, so the cache
builder container was created without a diagnostics sink. A prior fix for this same gap only
landed in the manual-dispatch `main_nihgithubportalcb.yml`, not the auto-deploy workflow. Added
the same `LA_WORKSPACE_ID`/`LA_WORKSPACE_KEY`/`LA_ARGS` wiring to `deploy-cb` to match `deploy-fh`.

---

## Fixed Redis crash-loop in `nihgithubportalfh` container (August 2026)

Log analysis of the `nihgithubportalfh` container instance (webhooks processor) showed a
crash-loop: roughly every 10–20 minutes, the process died with `SocketClosedUnexpectedlyError:
Socket closed unexpectedly` thrown as an unhandled `'error'` event, and Azure Container Instances
restarted it. Root cause: `middleware/redis.ts`'s shared `connectRedis()` (used by both the cache
and session Redis clients) never attached an `error` listener to the client, so any transient
socket error (idle disconnects, Azure Cache for Redis connection recycling) became an uncaught
exception that killed the whole process. Fix: attach an `.on('error', ...)` listener that logs the
error via `debug` instead of letting it crash the process.

---

## Dependency Updates (August 2026)

Worked through every open Dependabot PR plus the full `bun outdated` list at the repo root,
applying bumps in tiers (patch → minor → major), running `bun run build`, `bun run lint`, and
`bun run test` after each tier/package, and committing only on green.

- **Patch-level** (13 prod + 7 dev packages): `@azure/identity`, `@azure/keyvault-keys`,
  `@azure/keyvault-secrets`, `@octokit/auth-oauth-app`, `@octokit/auth-oauth-user`,
  `@octokit/graphql`, `@octokit/plugin-retry`, `@octokit/request`, `@octokit/request-error`,
  `dotenv`, `form-data`, `jose`, `toad-cache`, `@types/express-serve-static-core`,
  `@types/lodash`, `@types/luxon`, `cspell`, `eslint-plugin-prettier`, `eslint-plugin-security`,
  `vitest`. Added a `package.json` `overrides` entry pinning
  `@types/express-serve-static-core` to a single resolved version tree-wide — `@types/express`'s
  own `^5.0.0` dependency was resolving a stale nested copy, producing a `TS2742`
  non-portable-type build error.
- **Minor-level** (16 prod + 10 dev packages): `@azure/cosmos`, `@azure/msal-node`,
  `@azure/storage-blob`, `@azure/storage-queue`, `@octokit/auth-app`, `@primer/octicons`,
  `applicationinsights`, `axios`, `body-parser`, `express-session`, `highlight.js`, `hyparquet`,
  `liquidjs`, `morgan`, `pg`, `semver`, `@types/express-session`, `@types/multer`, `@types/pg`,
  `@types/semver`, `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`, `eslint`,
  `globals`, `markdownlint-cli2`, `prettier`. The `prettier` bump changed formatting expectations
  for 3 pre-existing files (`business/graphManager.ts`, `business/operations/core.ts`,
  `lib/github/appTokens.ts`); reformatted with `prettier --write` to clear new
  `eslint-plugin-prettier` errors.
- **Major-level**, one at a time with usage review before each: `@octokit/types` (16→17, no
  direct usage), `jwks-rsa` (3→4), `basic-auth` (2→3, no direct usage), `redis` + `connect-redis`
  (5→6 / 9→10, bumped together since connect-redis is a session-store adapter for the redis
  client), `js-yaml` (4→5, no direct usage, kept only for the security-floor `overrides` entry),
  `nodemailer` (8→9), `json-2-csv` (3→5, `json2csvAsync` renamed to `json2csv` in
  `routes/administration/index.ts`), `eslint-plugin-n` (17→18), `lint-staged` (16→17), `cspell`
  (10.0→10.1).
- **Reverted / held back:**
  - `typescript` 5.9.3 → 7.0.2: incompatible with the installed `@typescript-eslint` (`<6.1.0`
    peer range) and produced 40+ new compiler errors under its stricter inference. Staying on
    5.9.3.
  - `@types/node` 24.12.0 → 26.2.0: build/lint/test all passed, but reverted to stay aligned
    with the Node 24.x runtime pin in this file's sibling `AGENTS.md` — newer `@types/node` would
    type-check against Node APIs not present in the pinned 24.x runtime.
- `bun outdated` at the repo root is clean except for the two held-back packages above.
- Merged the open Dependabot GitHub Actions PRs (not covered by `bun outdated`, which only tracks
  npm/bun packages) separately from the dependency-bump commits.

---

## Fixed crash adopting an org already known to `operations` (August 2026)

Adopting an org that `Operations.getOrganizationSettingsInstance()` already had in memory (already
active, or from a legacy static config entry) threw "static keys which are not recognized..."
`createDynamicSettingsForNewOrganization()` was re-running the already-converted
`OrganizationSetting` back through `CreateFromStaticSettings()`, which only strips legacy
config field names, not the entity's own. Fix: `CreateFromStaticSettings()` now detects an
already-converted input and clones it defensively instead of re-mapping it.

---

## Filtered `NIHGitHubAdmin` out of repository admin cards (August 2026)

Same filter as the org Owners list fix below, applied to `business/repository.ts#getAdmins()`,
so `NIHGitHubAdmin` no longer shows up as an "Org Admin" card on every repository's detail page.

---

## Fixed 404 crash when viewing an Enterprise Team-backed org team's page (August 2026)

Enterprise Team-backed org teams (slug prefixed `ent:`) 404 on the classic
`GET /orgs/{org}/teams/{team_slug}/members` endpoint instead of returning an empty list,
crashing team pages. Fix: `business/team.ts#getMembers()` now returns `[]` for that case
instead of throwing the error; all other member/maintainer lookups build on top of it.

---

## Organization Page Fixes (August 2026)

- `NIHGitHubAdmin` (a service account) is now filtered out of the Owners list in `business/organization.ts#getOwnersCardData`, so it never appears on the org overview or public invitation pages.
- Removed the hardcoded 5-card limit on the Owners list (`views/nih/mixins.pug#orgAdminCards`); `views/org/index.pug` now renders all organization owners instead of truncating with no way to see the rest.
- `views/org/index.pug`: moved the "About the Organization" section above "Teams You Maintain" so it's visible without scrolling past team management tables.
- `views/org/index.pug`: the top `<> Organization` header now links the org name to the org on GitHub, so it's the first org link on the page instead of the "Open on GitHub" link further down.
- `views/footer.pug`: swapped column alignment so the NIH logo is left-aligned and the Version/legal notices/Contact/Contribute/Powered-by messaging is right-aligned; fixed the "Powered by" hyperlink so it ends on the word "source" instead of also wrapping the trailing comma.
- `views/footer.pug`: the "Powered by ... GitHub API." line sat ~5px (about one character) further right than the Version/Contact/Contribute lines above it, because those are `<li>`s inside Bootstrap's `.list-inline` (which adds `padding-right:5px`) while the Powered-by text wasn't wrapped in any element with matching padding. Wrapped both branches in a `span(style='padding-right:5px')` so all rows align to the same right edge.
- `views/nav2.pug`: navbar wrapper changed from `.container-fluid` to `.container` so the navbar content aligns with the fixed-width page container instead of spanning the full viewport width.
- `views/reposToolbar.pug`: same `.container-fluid` → `.container` fix for the Organizations/Repositories/Teams/People subnav, so it lines up with the fixed-width containers above and below it.
- `views/nav2.pug`: Settings icon changed from `glyphicon-option-vertical` (kebab menu) to `glyphicon-cog` (gear), which better signals "Settings".

---

## Azure Region Migration: Central US → East US (August 2026)

Moved the default Azure region for all Terraform-managed and ACI resources from `centralus` to `eastus`.

- `infra/terraform/dev/variables.tf`, `infra/terraform/prod/variables.tf`: default `location` → `eastus`
- ACI `--location` updated in `main_create_acr_image.yml`, `main_nihgithubportalcb.yml`, `main_nihgithubportalfh.yml`, `staging_create_acr_image.yml`, `staging_nihdevgithubportalcb.yml`, `staging_nihdevgithubportalfh.yml`

**Known/accepted impact:** `location` is immutable on `azurerm_log_analytics_workspace`, `azurerm_servicebus_namespace`, and `azurerm_user_assigned_identity`, so `terraform apply` destroys and recreates these rather than moving them in place. Accepted trade-off: a short window (~15 minutes) of lost Log Analytics history and any in-flight Service Bus messages during cutover, versus a costlier migration later. `staging_terraform_dev.yml` auto-applies on push to `staging`, so dev migrates immediately on merge; prod only migrates once this reaches `main`. The ACI deploy workflows already delete the container group before recreating it, so there's no location-conflict error, and those containers are stateless (state lives in Postgres/Redis), so no data loss there.

**Incident during rollout:** both dev and prod `terraform apply` runs destroyed the old Log Analytics workspace/Service Bus namespace but failed to recreate them in `eastus` (`409 InvalidResourceLocation`) — Azure doesn't release the name/location reservation immediately on delete (Log Analytics soft-deletes for 14 days; Service Bus namespace deletion is asynchronous). Required manually recovering + force-purging the Log Analytics workspaces and waiting for the Service Bus namespace name to free up before re-running `terraform apply`. Separately found `main_nihgithubportalcb.yml` was missing the `--log-analytics-workspace`/`--log-analytics-workspace-key` wiring that every other ACI deploy workflow (`staging_nihdevgithubportalcb.yml`, `main_nihgithubportalfh.yml`, `main_create_acr_image.yml`) has — a pre-existing gap unrelated to the region migration, now fixed, so the prod cache-builder container's logs actually reach Log Analytics.

---

## GitHub Actions Secret Reduction (June 2026)

Audit of all workflow secrets against Entra ID Workload Federation (OIDC) coverage.
The repo's service principal has Contributor on both subscriptions, so stored credentials
can be replaced with dynamic Azure API calls made within the already-authenticated session.

### ✅ Purge immediately — workflows already updated

Delete these secrets from both repos (NIHGOV/github-portal + staging env):

| Secret               | Was used in                    | Replacement                               |
| -------------------- | ------------------------------ | ----------------------------------------- |
| `DEV_REGISTRY_USER`  | Build + all 2 dev ACI deploys  | `az acr credential show` after OIDC login |
| `DEV_REGISTRY_PASS`  | Build + all 2 dev ACI deploys  | same                                      |
| `PROD_REGISTRY_USER` | Build + all 2 prod ACI deploys | `az acr credential show` after OIDC login |
| `PROD_REGISTRY_PASS` | Build + all 2 prod ACI deploys | same                                      |

Prerequisite: ACR admin user must be enabled on both registries (needed by `az acr credential show`).
Alternative if admin is disabled: assign a user-assigned managed identity with AcrPull to ACI groups instead.

### ✅ Replace with OIDC — done (issue #1122)

| Secret                                                            | Workflow                         | Replacement                                          |
| ----------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------- |
| `AZUREAPPSERVICE_PUBLISHPROFILE_34824FEBDA0F4C8CACF5CB97111CBFFB` | `staging_nihdevgithubportal.yml` | Add `azure/login` OIDC step; drop `publish-profile:` |
| `AZUREAPPSERVICE_PUBLISHPROFILE_990190F22A5149AC859307273BAE196C` | `main_nihgithubportal.yml`       | Same                                                 |

### ✅ Secrets converted to variables (June 2026)

Non-sensitive values moved from secrets to repository variables (visible in Actions but not credential material):

| Variable                   | Value                  | Used in                                                         |
| -------------------------- | ---------------------- | --------------------------------------------------------------- |
| `DEV_SERVICEBUS_NAMESPACE` | `nihdevgithubportalsb` | `staging_terraform_dev.yml`, `staging_nihdevgithubportalfh.yml` |
| `DEV_TF_STORAGE_CONTAINER` | `tfstate`              | `staging_terraform_dev.yml`                                     |

### Pending: staging → main merge (production equivalents — tracked in #1128)

After the next staging → main merge, create the following repository variables in GitHub:

| Variable                    | Value                     | Used in                                                 |
| --------------------------- | ------------------------- | ------------------------------------------------------- |
| `PROD_SERVICEBUS_NAMESPACE` | prod Service Bus name     | `main_terraform_prod.yml`, `main_nihgithubportalfh.yml` |
| `PROD_TF_STORAGE_CONTAINER` | `tfstate` (or equivalent) | `main_terraform_prod.yml`                               |

Then delete the corresponding `PROD_SERVICEBUS_CONNECTIONSTRING` secret once managed identity is verified working in prod (mirrors the dev→managed-identity migration).

### Keeping as secrets (decision: June 2026)

All other identifiers (client IDs, tenant IDs, subscription IDs, resource group names,
hostnames, usernames, app IDs, slugs, storage account names) remain as encrypted secrets
per team preference — none of their business if breached.

---

## Terraform Infrastructure (June 2026)

`infra/terraform/dev/` manages Azure resources in `GitHub_OpenSource_Portal_Dev`.
Long-term goal: represent the entire `GitHub_OpenSource_Portal_Dev` (and eventually
`GitHub_OpenSource_Portal`) resource group in Terraform.

### Bootstrap (one-time, manual)

Before the workflow can run, a storage account for Terraform state must exist:

- [x] ~~Create a storage account in `GitHub_OpenSource_Portal_Dev` (e.g. `nihdevgithubportaltf`)~~
- [x] Create a blob container in it (e.g. `tfstate`) — or confirm it exists
- [x] ~~Grant service principal **Storage Blob Data Contributor** on `nihdevgithubportaltf`~~
- [x] Add GitHub Secrets:
  - `DEV_TF_STORAGE_ACCOUNT` → `nihdevgithubportaltf`
  - `DEV_TF_STORAGE_CONTAINER` → container name (e.g. `tfstate`)
  - ~~`GH_SECRETS_PAT`~~ — not needed; ACI workflows look up Log Analytics from Azure at deploy time via `az monitor`

### Dev resources managed

- [x] `azurerm_log_analytics_workspace` — `nihdevgithubportal-logs`
- [x] Log Analytics ID/key wired into ACI deploys: looked up at runtime via `az monitor log-analytics workspace show/get-shared-keys` — no secrets required

### Prod bootstrap (one-time, before Terraform prod apply)

- [x] Create/confirm Terraform state storage account for prod (e.g. `nihgithubportaltf`) in `GitHub_OpenSource_Portal`
- [x] Create blob container (e.g. `tfstate`) in it
- [x] Grant service principal **Storage Blob Data Contributor** on the prod state storage account
- [x] Add GitHub Secret `PROD_TF_STORAGE_ACCOUNT` → prod storage account name (also listed in ACI Production above)

---

## ACI Container Deployment (June 2026)

Replaced hardcoded-secret YAML files with GitHub Actions workflows and `infra/aci/` reference configs.

**Update (Aug 2026):** Deleted `infra/aci/{staging,prod}-firehose.yml` and `infra/aci/{staging,prod}-cachebuilder.yml` — they documented the old static ACR credential + Service Bus connection-string approach, which the active workflows no longer use (managed identity + OIDC `az acr credential show` instead).

**Update (Aug 2026):** Added the `azure-cli` devcontainer feature to `.devcontainer/devcontainer.json` so `az` is available out of the box, matching the `az login`/OIDC workflows referenced throughout this plan.

### Staging

- [x] Add GitHub Secret `DEV_RG` → `GitHub_OpenSource_Portal_Dev`
- [x] Add GitHub Secret `DEV_REGISTRY_SERVER` → dev ACR hostname
- [x] Add GitHub Secret `DEV_REDIS_TLS_HOST`
- [x] Add GitHub Secret `DEV_REDIS_KEY`
- [x] Add GitHub Secret `DEV_POSTGRES_HOST`
- [x] Add GitHub Secret `DEV_POSTGRES_DB`
- [x] Add GitHub Secret `DEV_POSTGRES_USER`
- [x] Add GitHub Secret `DEV_POSTGRES_PASSWORD`
- [x] Add GitHub Secret `DEV_WEBHOOK_SHARED_SECRET` → webhook HMAC secret from dev GitHub App settings
- [x] Add GitHub Secret `DEV_GITHUB_APP_OPERATIONS_APP_ID`
- [x] Add GitHub Secret `DEV_GITHUB_APP_OPERATIONS_KEY`
- [x] Add GitHub Secret `DEV_GITHUB_APP_OPERATIONS_SLUG`
- [x] Add GitHub Variable `DEV_SERVICEBUS_NAMESPACE` → `nihdevgithubportalsb` ✅ done
- [x] ~~Run Terraform dev workflow~~ — ✅ complete: namespace + identity + role assignment all created
- [x] Run `staging_nihdevgithubportalfh.yml` — ✅ firehose deployed and verified
- [x] ~~Run `staging_nihdevgithubportalcb.yml`~~ — ✅ cache builder deployed and verified
- [x] Run `staging_nihdevgithubportalfh.yml` manually — ✅ firehose container starts, polls `events` queue every 10s
- [x] Run `staging_nihdevgithubportalcb.yml` manually — ✅ cache builder runs, saves repo permissions to DB
- [x] Restart `nihdevgithubportal` App Service — ✅ ARPA-H org description appears on homepage

### Production ✅ Complete (August 2026)

- [x] Add GitHub Secret `PROD_RG` → `GitHub_OpenSource_Portal`
- [x] Add GitHub Secrets `PROD_AAD_CLIENT_ID`, `PROD_AAD_CLIENT_SECRET`, `PROD_AAD_SUBSCRIPTION_ID`, `PROD_AAD_TENANT_ID` (may match existing `AAD_*` values)
- [x] Add GitHub Secret `PROD_REGISTRY_SERVER` → prod ACR hostname (e.g. `nihgithubportal.azurecr.io`)
- [x] Add GitHub Secret `PROD_REDIS_TLS_HOST`
- [x] Add GitHub Secret `PROD_REDIS_KEY`
- [x] Add GitHub Secret `PROD_POSTGRES_HOST`
- [x] Add GitHub Secret `PROD_POSTGRES_DB`
- [x] Add GitHub Secret `PROD_POSTGRES_USER`
- [x] Add GitHub Secret `PROD_POSTGRES_PASSWORD`
- [x] Add GitHub Secret `PROD_WEBHOOK_SHARED_SECRET` → webhook HMAC secret from the prod GitHub App settings (needed by firehose; learned from staging)
- [x] ~~`PROD_SERVICEBUS_CONNECTIONSTRING`~~ — never needed; went straight to managed identity
- [x] Add GitHub Variable `PROD_SERVICEBUS_NAMESPACE` → prod Service Bus namespace name
- [x] Add GitHub Variable `PROD_TF_STORAGE_CONTAINER` → `tfstate` (or equivalent)
- [x] Add GitHub Secret `PROD_TF_STORAGE_ACCOUNT` → prod Terraform state storage account name (also required for Terraform prod bootstrap below)
- [x] Add GitHub Secret `PROD_GITHUB_APP_OPERATIONS_APP_ID`
- [x] Add GitHub Secret `PROD_GITHUB_APP_OPERATIONS_KEY`
- [x] Add GitHub Secret `PROD_GITHUB_APP_OPERATIONS_SLUG`
- [x] Apply `WEBSITE_RUN_FROM_PACKAGE=1`, Entra env vars, and all required App Service settings to `nihgithubportal` (see High Priority §0)
- [x] Run Terraform prod workflow (`main_terraform_prod.yml`, action: apply) — provisions `nihgithubportal-firehose` managed identity, Service Bus namespace, queue, and role assignment
- [x] Run `main_nihgithubportalfh.yml` manually — ✅ firehose deployed and verified (2026-08-22)
- [x] Run `main_nihgithubportalcb.yml` manually — ✅ cache builder deployed and verified (2026-08-22)
- [x] Run `main_nihgithubportal.yml` — ✅ deployed to `nihgithubportal` App Service (PR #1171 merge, 2026-08-24: "Successfully deployed web package to App Service.")
- [x] Verify `nihgithubportal` App Service starts and portal is accessible — confirmed via successful deploy + no startup failures across repeated runs

---

## Managed Identity — Service Bus (June 2026)

Replaces `SERVICEBUS_CONNECTIONSTRING` secret with Azure managed identity + `DefaultAzureCredential`.
No credential to rotate or leak; ACI picks up the identity at runtime.

### How it works

1. Terraform provisions `azurerm_user_assigned_identity` (`nihdevgithubportal-firehose` / `nihgithubportal-firehose`)
2. Terraform assigns `Azure Service Bus Data Receiver` role on the Service Bus namespace
3. ACI deploy workflow passes `--assign-identity <identity-resource-id>` and `AZURE_CLIENT_ID=<client-id>` so `DefaultAzureCredential` selects the right identity
4. `GITHUB_WEBHOOKS_SERVICEBUS_ENDPOINT=<namespace>.servicebus.windows.net` (no `https://` — SDK prepends `sb://` internally)
5. `lib/queues/servicebus.ts` uses `useEntraAuthentication` flag to branch between credential and connection-string mode

### Staging status (tracked in #1127) ✅ Complete

- [x] Code changes on `staging` branch
- [x] `DEV_SERVICEBUS_NAMESPACE` variable set in GitHub → `nihdevgithubportalsb`
- [x] `nihdevgithubportalsb` Service Bus namespace created (Terraform)
- [x] `nihdevgithubportal-firehose` managed identity created (Terraform)
- [x] `Azure Service Bus Data Receiver` role assignment created (Terraform, after User Access Administrator granted)
- [x] Firehose container deployed and verified
- [x] Cache builder deployed and verified

### Production (after staging → main merge — tracked in #1128) ✅ Complete

- [x] `PROD_SERVICEBUS_NAMESPACE` variable set in GitHub → prod namespace name
- [x] `PROD_TF_STORAGE_CONTAINER` variable set in GitHub → `tfstate`
- [x] Terraform prod apply run
- [x] `nihgithubportalsb` Service Bus namespace created (Terraform)
- [x] `nihgithubportal-firehose` managed identity created (Terraform)
- [x] `Azure Service Bus Data Receiver` role assignment created (Terraform)
- [x] Firehose container deployed and verified
- [x] Cache builder deployed and verified

---

### ✅ Fixed `ENOENT ... datasharing.pug` crash on `/settings/contributionData` (August 2026)

Visiting `/settings/contributionData` threw `ENOENT: no such file or directory, open '.../views/corporate/contributions/datasharing.pug'`.

Root cause: `middleware/corporateViews.ts` scans `views/corporate/` at startup and flags a feature as available (e.g. `corporateViews.contributions.datasharing`) whenever it finds **any file** with a matching base name, regardless of extension. Pug templates (e.g. `views/settings/contributionData.pug`) then do a literal `include ../corporate/contributions/datasharing`, which only resolves `.pug` files. A stray non-`.pug` file (or a `.pug` file removed after startup by a non-atomic/additive deploy while the flag stayed cached in memory) caused the flag to be `true` with no matching `.pug` file to include, crashing the page for the lifetime of the process.

This repo doesn't ship a `views/corporate/` directory at all (it's an optional extension point for downstream forks), so the leftover flag most likely came from stale files accumulated on the App Service under a Kudu additive deploy — the same class of issue documented in `AGENTS.md` under `WEBSITE_RUN_FROM_PACKAGE`.

Code fix: `middleware/corporateViews.ts` — `recurseDirectory()` now only flags files with a `.pug` extension, so a stray/stale non-`.pug` file can never cause a template to `include` a view that doesn't exist.

**Operational follow-up:** confirm `WEBSITE_RUN_FROM_PACKAGE=1` is applied and redeploy/restart the affected App Service so any stale `views/corporate` remnants under `wwwroot` are discarded.

### ✅ Fixed admin apps page showing wrong GitHub App slug and broken "Install in new org" link (June 2026)

`/administration/apps` displayed the slug from `GITHUB_APP_OPERATIONS_SLUG` as both the "GitHub App" and "Purpose" columns, and used that slug to build the "Install in new org" link. Two issues combined to cause the broken link and misleading display:

1. **Wrong env var value**: `GITHUB_APP_OPERATIONS_SLUG` was set to `nihdevgithubportal-app-ops` (the old/renamed app name) instead of the current slug `dev-nih-github-management-portal`. Fix: update the App Service setting to match the actual slug shown at `github.com/organizations/NIHGOV/settings/apps/…`.

2. **Code bug**: `initializeAppById` in `business/operations/core.ts` called `tokenManager.getSlugById()` for _both_ the `slug` and `friendlyName` parameters, so the "Purpose" column showed the raw slug instead of the human-readable description (e.g. "GitHub Operations") from the app's JSON config.

Code fix:

- `lib/github/tokenManager.ts` — added `_appFriendlyNames` map; populated it alongside `_appSlugs` in `initializeApp`; added `getFriendlyNameById()` accessor
- `business/operations/core.ts` — `initializeAppById` now calls `getFriendlyNameById()` for the friendlyName, falling back to the slug only when no description is configured
- `AGENTS.md` — documented `GITHUB_APP_OPERATIONS_SLUG` in the required App Service settings table

**⚠️ Required before merging to main:** Verify `GITHUB_APP_OPERATIONS_SLUG` is set correctly on both App Services (`nihdevgithubportal` and `nihgithubportal`). The value must exactly match the slug shown at `github.com/organizations/NIHGOV/settings/apps/…` (e.g. `dev-nih-github-management-portal` on staging). An incorrect slug causes broken "Install in new org" links and silently misidentifies bot commits in `getApplicationsAsLogins()`.

## Completed (June 2026 — GitHub Copilot agentic session)

### ✅ Resolved staging ← main merge conflicts; preserved all NIH-only changes (June 2026)

Merged `origin/main` into `staging`, resolving 14 conflicts across workflow files, Terraform configs, `lib/queues/servicebus.ts`, `.cspell.json`, and `PLAN.md`. All NIH-specific changes (managed identity, Service Bus, Terraform infrastructure) were preserved by taking `--ours` on all conflicts.

### ✅ Added CodeQL inline suppression comments for 41 false-positive alerts (June 2026)

41 CodeQL alerts across 20 files suppressed with `// codeql[rule-id]` comments.
The `js/missing-rate-limiting` alerts remain suppressed because CodeQL cannot trace cross-file middleware registration — the suppressions are still correct explanatory annotations even though enforcement is now on by default (see rate limiting section below).

- `js/missing-rate-limiting` (37 alerts) — inline suppressions retained as documentation; enforcement enabled separately (see below)
- `js/unvalidated-dynamic-method-call` (3 alerts) — `business/*Search.ts` guards method existence via `this[sortMethodName]` check
- `js/insufficient-password-hash` (1 alert) — `middleware/rateLimit.ts` uses SHA-256 as a cache key compactor, not a credential hash

### ✅ Enabled rate limiting enforcement; tightened unauthenticated threshold (June 2026)

`config/rateLimit.json` was previously shipped with `mode=disabled` and `audit.enabled=0` — rate limiting infrastructure existed but was entirely inert. Changed defaults:

- `mode`: `disabled` → `enforce`
- `audit.enabled`: `0` → `1`
- `thresholdUnauthenticated`: `120` → `20` req/min/path (authenticated users retain 120)

Enforcement can be overridden via `RATE_LIMIT_MODE` / `RATE_LIMIT_AUDIT_*` App Service settings without a code change.

Also added a test (`middleware/rateLimit.test.ts`) confirming that the tighter unauthenticated threshold blocks at 20 while authenticated users at the same path still pass through at 120.

### ✅ Resolved all 45 bun audit vulnerabilities (June 2026)

- Direct bumps: `liquidjs` 10.25.5 → 10.27.0 (7 CVEs); `axios` 1.15.0 → 1.17.0 (19 CVEs)
- Transitive overrides added: `cookie`, `fast-xml-parser`, `joi`, `js-yaml`, `json-bigint`, `on-headers`, `protobufjs`, `smol-toml`, `uuid`, `xml2js`
- `bun audit` now reports 0 vulnerabilities

### ✅ Build traceability in ACI container startup logs (June 2026)

Containers now log three lines on startup:

```text
build: 8.5.<run_number>, opensource-management-portal
commit: <8-char SHA>
actions: https://github.com/NIHGOV/github-portal/actions/runs/<run_id>
```

- `config/continuousDeployment.js` — reads `GITHUB_SHA` (short form) and `GITHUB_RUN_ID`; attaches as `continuousDeployment.commit` / `.runUrl`
- `middleware/initialize.ts` — logs `commit:` and `actions:` lines separately when values are present
- All four CB/FH deploy workflows — pass `GITHUB_SHA`, `GITHUB_RUN_ID`, `GITHUB_RUN_NUMBER` as env vars to the containers

### ✅ Fixed container CI/CD pipeline: SHA-tagged images, race condition, missing source paths (June 2026)

**Race condition fixed:** ACR build workflows now push `portal:<full-sha>` alongside `portal:latest`. CB/FH deploys consume `portal:<sha>` directly, so rapid back-to-back pushes can never cause a deploy to pull the wrong image.

**workflow_run default-branch bug fixed:** `workflow_run`-triggered workflows always execute from the repository's default branch (`main`), not the branch that triggered them. This meant all CB/FH deploy workflow changes on `staging` were silently ignored, and containers kept deploying `portal:latest` from `main`'s old workflow version.

Fix: consolidated `deploy-cb` and `deploy-fh` as jobs inside `staging_create_acr_image.yml` / `main_create_acr_image.yml` (`needs: build`). Since these workflows trigger on `push` to their respective branch, they always run the correct branch version with `${{ github.sha }}` directly.

The standalone `staging_nihdevgithubportalcb/fh.yml` and `main_nihgithubportalcb/fh.yml` are now **manual-dispatch only** with an `image_tag` input (default: `latest`) for rollbacks and targeted redeploys without a full rebuild.

**Missing source paths fixed:** `api/**`, `bin/**`, `middleware/**`, `routes/**`, `typings/**`, `index.ts`, `job.ts` added to path filters in all ACR build workflows. Changes to these directories now correctly trigger a new container image.

### ✅ Removed duplicate/stale main_create_acr_image.yaml (June 2026)

`.github/workflows/main_create_acr_image.yaml` had the same workflow `name:` and identical push path triggers as `main_create_acr_image.yml` but ran a completely different job — a GraphQL org query + PowerShell `Create-EnvOrgs.ps1` script. It was silently failing on every `main` push (trying to `rm env-orgs.json` which doesn't exist) while the real ACR build ran alongside it. Deleted.

### ✅ Removed static-mode org config artifacts (June 2026)

- Deleted `.github/scripts/Create-EnvOrgs.ps1` — generated an incomplete org JSON (no `installations` block) for the old file-based `GITHUB_ORGANIZATIONS_FILE` mode; not wired into any active workflow
- Removed stale `GITHUB_ORGANIZATIONS_FILE: ../env-orgs.json` from `infra/aci/prod-firehose.yml` and `infra/aci/staging-firehose.yml` (contradicted by the adjacent `GITHUB_ORGANIZATIONS_SOURCE: postgres`)

### ✅ Fixed update_orgsettings workflows: OIDC login, double-$ typo, deprecated psql action (June 2026)

Both `staging_update_orgsettings_table.yaml` and `main_update_orgsettings_table.yaml`:

- `azure/login`: replaced deprecated JSON `creds:` format with OIDC `client-id`/`tenant-id`/`subscription-id`; added `permissions: id-token: write` block
- PSQL step: replaced deprecated `azure/postgresql@v1.2.0` with `apt install postgresql-client` + `psql` CLI — works with any Postgres endpoint
- Fixed `$${{ secrets.*_PSQL_SERVER }}` double-`$` typo (would have passed literal `$<value>` as server name, silently breaking the connection)

---

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
| `REDIS_KEY`                                  | _(Azure Cache for Redis primary access key)_                                                                                         | Without it, all Redis commands fail with `NOAUTH Authentication required`                                             |
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

### Corporate Identity Tenant Migration Ledger (generic — not tied to one tenant pair)

For a batch of users who moved from one Entra tenant to another (NIH → ARPA-H was the first case,
but this is intentionally generic since it can happen again with any other tenant pair), use the
toolkit under [`scripts/tenantMigration/`](scripts/tenantMigration) instead of hand-editing rows or
relying on local files. State lives in a Postgres ledger table (`identitytenantmigrations`,
self-created by the scripts on first run via `ensureSchema()` — no manual DB migration needed).
Run it via the [`tenant_migration.yml`](.github/workflows/tenant_migration.yml) workflow (manual
dispatch, OIDC, runs as a one-shot ACI container using the already-built portal image) — not by
SSHing into an App Service.

Each row in the ledger tracks one GitHub identity through the whole process — discovered ("before")
corporate identity, intended ("target") corporate identity, and what was actually applied
("after") — via a `status` column: `pending` → `needs-review` → `ready` → `applied` (or `conflict`/
`failed`). Nothing is ever deleted from the ledger, so it doubles as an audit trail and makes every
mode safely re-runnable.

The workflow has two modes:

#### `gather` — find candidates and produce a file to edit

Scans one or more GitHub orgs' members and flags candidates by simple substring criteria against
each linked member's _currently stored_ corporate identity — UPN/email contains, display name
contains, or org membership alone if no other criteria are given:

```bash
gh workflow run tenant_migration.yml \
  -f environment=dev \
  -f mode=gather \
  -f batch_id=<source-tenant>-to-<target-tenant>-2026-08 \
  -f github_orgs=<org1,org2> \
  -f upn_contains=<source-tenant-domain> \
  -f exclude_upn_contains=<target-tenant-domain>
```

This writes every match to the ledger table (never to `links`), and also uploads a **downloadable,
encrypted artifact** on the workflow run named `tenant-migration-candidates-<batch-id>` -- an
AES-256-CBC-encrypted JSON file (`candidates-<batch-id>.json.enc`), one entry per candidate,
pre-filled with their discovered identity and blank `new*` fields. Encrypted because on this
public repo, artifact downloads only require repo read access -- any signed-in GitHub user, not
just this org:

```bash
gh run download <run-id> -n tenant-migration-candidates-<batch-id>
openssl enc -d -aes-256-cbc -pbkdf2 -pass env:TENANT_MIGRATION_ARTIFACT_PASSPHRASE \
  -in candidates-<batch-id>.json.enc -out candidates-<batch-id>.json
```

(`TENANT_MIGRATION_ARTIFACT_PASSPHRASE` is the same repo secret the workflow encrypts with --
get it from whoever manages this repo's secrets, not from the workflow run itself.)

Edit that file: for each person you want to migrate, fill in `newCorporateId` (their OID in the
target tenant — get this from `az ad user show --id user@target-tenant.example --query id -o tsv`
after `az login --tenant <target-tenant-id>`), `newCorporateUsername`, and optionally
`newCorporateDisplayName`/`newCorporateMailAddress`. **Never auto-match on email local-part
alone** — hand-verify each pairing (name, known alias, HR migration list); a wrong match links one
person's GitHub account to someone else's corporate identity. Leave a row's `newCorporateId` blank
to skip migrating that person.

You can also inspect the raw ledger directly instead of/alongside the downloaded file:

```sql
SELECT thirdpartyusername, discoveredcorporateusername, status
FROM identitytenantmigrations
WHERE batchid = '<batch-id>';
```

#### `patch` — apply the edited file

```bash
gh workflow run tenant_migration.yml \
  -f environment=dev \
  -f mode=patch \
  -f batch_id=<batch-id> \
  -f candidates_json_base64="$(base64 -w0 candidates-<batch-id>.json)"
```

This first records your edited target identities in the ledger (moving edited rows to `ready`,
skipping any row you left blank), then applies them to `links` — dry run by default; the
container's own output (the before/after diff) is not echoed to this public workflow log --
check Log Analytics for the run's `GITHUB_RUN_ID` instead -- then re-run with `-f commit=true`
(`environment=dev` first, then `environment=prod`). For each `ready` row, it re-fetches the live
`links` row and checks it still matches what was discovered during `gather`; if something changed
in between (e.g. someone re-linked, or another operator already touched it), the row is marked
`conflict` instead of being blindly overwritten. Successful updates are marked `applied` with both
the before and after snapshot recorded on the ledger row.

Then follow Steps 3–4 of the single-user procedure above (confirm `ENTRA_ID_ALLOWED_TENANT_IDS`,
have each user sign in).

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

Dependabot covers `/` and `/default-assets-package` for bun, but the `frontend/` directory has its own `package.json` (referenced in `Dockerfile` as `WORKDIR /build/frontend`) and is not covered.

- [ ] Add a third entry to `dependabot.yml` (check whether `frontend/` uses its own lockfile format — `bun` if it has a `bun.lock`, otherwise `npm`):

  ```yaml
  - package-ecosystem: bun
    directory: /frontend
    target-branch: staging
    schedule:
      interval: daily
    open-pull-requests-limit: 10
    commit-message:
      prefix: 'bun - frontend'
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
- Dependabot covering bun (`/`, `/default-assets-package`), GitHub Actions, and Docker
- CodeQL scanning on push and weekly (`codeql-analysis.yml`)
- API token validation via Entra in `middleware/api/authentication/`
- Session production guards (rejects `memory`/`file` providers in production)
- Rate limiting on all API routes (GHAS alerts resolved May 2026)
- Redis v5 auth handled correctly via `createClient({ password })` (fixed May 2026)

---

## Future: full resource group import via aztfexport

**Prerequisites:** staging verified stable, staging → main merged, prod stabilized.

Use `aztfexport` to import all remaining resources into the existing Terraform state backends.
No data will be modified — `terraform import` only updates state; actual Azure resources are untouched.

### Dev (`GitHub_OpenSource_Portal_Dev`)

1. Run locally (requires `az login` + `aztfexport` installed):

   ```bash
   aztfexport resource-group GitHub_OpenSource_Portal_Dev --output-dir /tmp/aztfexport-dev
   ```

2. Feed output to agent — reconcile with existing `infra/terraform/dev/main.tf`, remove duplicate blocks for resources already in state (Service Bus namespace, queue, managed identity, role assignment, Log Analytics)
3. Add `lifecycle { ignore_changes = [app_settings] }` to App Service resource to prevent Terraform from blanking sensitive settings not in HCL
4. Run `terraform plan` — must show zero destructive changes before committing
5. Commit cleaned HCL to `infra/terraform/dev/`

### Prod (`GitHub_OpenSource_Portal`)

Repeat same process against prod resource group using `infra/terraform/prod/` and `nihgithubportaltf` state backend.

### Resources to import (both envs)

- [ ] Redis Cache
- [ ] PostgreSQL Flexible Server
- [ ] Container Registry (ACR)
- [ ] App Service (with `ignore_changes = [app_settings]`)
- [ ] ACI container groups (firehose, cache builder)
- [ ] Virtual network / subnets (if any)
- [ ] Any remaining role assignments, diagnostic settings
