# Security Improvement Plan

Priority-ordered list of security improvements identified across this repository.

---

## High Priority

### 1. Add `helmet` middleware (CSP, X-Frame-Options, nosniff, Referrer-Policy)

**Files:** `middleware/index.ts`, `package.json`

The middleware stack currently only sets HSTS and disables `X-Powered-By`. No `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, or `Referrer-Policy` headers are sent. These are the primary browser-side defenses against XSS and clickjacking.

- [ ] `npm install helmet`
- [ ] Register `app.use(helmet({ ... }))` early in `middleware/index.ts`, before routing
- [ ] Define a CSP policy appropriate to the app's asset sources (GitHub, Azure CDN, etc.) — start in report-only mode (`helmet.contentSecurityPolicy({ reportOnly: true })`) to avoid breaking changes, then harden

---

### 2. Pin GitHub Actions to commit SHAs

**Files:** `.github/workflows/*.yml`

All workflows use floating semver tags (`actions/checkout@v6`, `github/codeql-action/analyze@v3`). If an upstream tag is force-pushed, the new code runs in CI with full repository access. Pinning to the commit SHA guarantees immutability.

- [ ] For each `uses:` line, replace the tag with the corresponding commit SHA and add the version as a comment, e.g.:
  ```yaml
  uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4.2.2
  ```
- [ ] Use [pin-github-action](https://github.com/mheap/pin-github-action) or the [Ratchet](https://github.com/sethvargo/ratchet) CLI to automate the initial pinning
- [ ] Add Dependabot's `github-actions` ecosystem config (already present in `dependabot.yml`) to keep SHA pins updated automatically

---

### 3. Add `permissions:` blocks to all workflows

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

There is a 6-year-old `// TODO: 2020: consider SameSite` comment at line 77. The session cookie is currently created without an explicit `sameSite` attribute. Modern browsers default to `Lax`, but this is not enforced server-side. Setting it explicitly documents intent and provides defense-in-depth against CSRF for the OAuth redirect flows.

- [ ] Add `sameSite: 'lax'` to the `settings.cookie` object in `middleware/session.ts`
- [ ] Verify that `sameSite: 'lax'` is compatible with the Entra ID and GitHub OAuth callback flows (both use `GET` redirects, so `lax` should work; use `'none'` with `secure: true` only if a cross-site POST flow requires it)

---

### 5. Add `npm audit` step to CI

**File:** `.github/workflows/ci.yml`

Dependabot PRs can take days; a failing `npm audit` step catches known vulnerabilities on every push, including on branches that predate a Dependabot fix.

- [ ] Add to `ci.yml` after the install step:
  ```yaml
  - name: Audit dependencies
    run: npm audit --audit-level=high
  ```
- [ ] Consider adding `--production` flag to limit to production dependency tree

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

### 8. Verify npm package signatures in CI (`npm audit signatures`)

**File:** `.github/workflows/ci.yml`

npm 9+ supports `npm audit signatures`, which verifies that published packages are signed by the registry key they claim. This detects packages where the tarball has been tampered with post-publish — distinct from `npm audit` which checks advisories.

- [ ] Add to `ci.yml` after install:
  ```yaml
  - name: Verify package signatures
    run: npm audit signatures
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

- [ ] Replace `\`create database ${db}\`` with `escape('create database %I', db)` using the already-imported `pg-escape` package

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

- `npm install --ignore-scripts` in `Dockerfile` — prevents malicious install scripts
- `package-lock.json` lockfileVersion 3 with integrity hashes — deterministic installs
- `npm ci` for all CI and production builds
- `app.disable('x-powered-by')` in `middleware/index.ts`
- HSTS with preload and `includeSubDomains` via `middleware/hsts.ts`
- `eslint-plugin-security` integrated in `eslint.config.mjs`
- OIDC-based Azure auth in `container.yml` (no static Azure credentials)
- Dependabot covering npm (`/`, `/default-assets-package`), GitHub Actions, and Docker
- CodeQL scanning on push and weekly (`codeql-analysis.yml`)
- API token validation via Entra in `middleware/api/authentication/`
- Session production guards (rejects `memory`/`file` providers in production)
