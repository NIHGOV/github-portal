# Open Source Management Portal

> **Note:** 2025 note: this project does not entirely build today and is a partial reference implementation for example purposes only

This application represents the home for open source engineering experiences
at Microsoft. As a backend application it manages source of truth for many
types of corporate open source metadata, historical intent of repos
and projects, hosts a rich front-end, and also a set of APIs used by partner
teams.

While we prefer native GitHub experiences, when it comes to displaying certain info
and being more transparent about permissions and metadata, especially on
GitHub, which has no extensible user interface, we end up using and driving
people to this Open Source Management Portal to get the information they
need.

At Microsoft, 70,000 engineers are using a version of this portal as part of
their open source engineering experience. However, Microsoft does have a set
of "company-specific" extensions, including a separate React frontend client,
that are not currently part of this repository. And... yup, if we were to
start over today, we'd probably make this a Next.js-or-similar project.

Core capabilities and features of this application:

- **Linking GitHub accounts ⛓️** for enterprise use
- **Self-service GitHub organization joining 🙋** for engineers
- **Creating and managing GitHub open source repositories 👩‍💻**
- **Displaying transparent information, metrics, and company-specific data** about our GitHub open source presence around permissions, access, metadata, intent, and especially cross-organization views and search indexes
- **People inventory 👨‍🦳🧑‍🚀🧒🏽** to help people connect GitHub public logins with corporate identities
- **Intercepting forks and new repositories 🔐** to inject compliance and approval processes
- **Disable and enable 🔑** experiences for GitHub repositories
- **Sudo ⚡️** capabilities for repos, teams, organizations to remove persistent broad ownership and admin permissions
- **Hosting APIs 🍽️** to create repos, large-scale orgs to access link data, and reports
- **Background jobs 👷‍♂️** to maintain eventual consistency, run tasks, gather metrics, and prepare OKRs
- **Team join requests/approvals with context 🚪** building beyond the GitHub experience
- **Automated offboarding 🛶** when people take on new opportunities

The management portal is designed to be fast, efficient, and get out of the way of engineers
to get their important work done, with an emphasis on _relentless automation_ and _delegation_.

Most of the experience is eventually consistent; however, operational actions
such as joining teams, orgs, sudo operations, etc., are fully consistent at the time
they are requested.

## Deployment notes (NIH fork)

This NIH fork deploys to two Azure App Services:

- **Staging** (`nihdevgithubportal`) — built and deployed by `.github/workflows/staging_nihdevgithubportal.yml` on every push to the `staging` branch. Uses `WEBSITE_RUN_FROM_PACKAGE=1`, so `/home/site/wwwroot` is mounted **read-only and immutable** from the deploy zip on every cold start.
- **Production** (`nihgithubportal`) — built and deployed by `.github/workflows/main_nihgithubportal.yml` on every push to `main`. Uses `WEBSITE_RUN_FROM_PACKAGE=1` (same as staging). **Before the first deploy from `main`, apply the required App Service settings** — see `PLAN.md` (High Priority item 0) and `AGENTS.md`.

**If the app is crash-looping on startup with a `SyntaxError` about `@azure/core-tracing` not exporting `createTracingClient` (or a similar `@azure/*` ESM named-export error), read `AGENTS.md` first.** That document explains exactly why this happens, what _doesn't_ fix it (shipping more files, bumping versions, re-running the deploy), and the actual fix.

### Corporate identity tenant migrations

When a batch of users moves from one Entra tenant to another (e.g. NIH → ARPA-H), their existing
`links` rows need to be re-pointed at the new tenant's identity without losing their GitHub link.
This fork includes a generic, ledger-backed toolkit for that — [`scripts/tenantMigration/`](scripts/tenantMigration),
run via the [`tenant_migration.yml`](.github/workflows/tenant_migration.yml) GitHub Actions
workflow (`gather` mode finds candidates and produces a downloadable JSON file to fill in; `patch`
mode applies the edited file). See `PLAN.md` ("Corporate Identity Tenant Migration Ledger") for the
full workflow, including how to test against a single user before rolling out to the rest of a batch.

## LICENSE

[MIT License](LICENSE)

## Contributing

This project welcomes contributions and suggestions. Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit <https://cla.opensource.microsoft.com>.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Trademarks

This project may contain trademarks or logos for projects, products, or services. Authorized use of Microsoft
trademarks or logos is subject to and must follow
[Microsoft's Trademark & Brand Guidelines](https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks/usage/general).
Use of Microsoft trademarks or logos in modified versions of this project must not cause confusion or imply Microsoft sponsorship.
Any use of third-party trademarks or logos are subject to those third-party's policies.
