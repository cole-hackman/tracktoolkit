# Azure infrastructure

Everything Track Toolkit needs on Azure, as code. `docs/internal/MIGRATION.md` at the repo
root holds the decisions, verification log and open items; this file is the
operator's quick reference.

| Resource | Name | Notes |
|---|---|---|
| Resource group | `rg-tracktoolkit` | `westus3` (westus2 had no Burstable Postgres capacity for this subscription) |
| App Service plan | `tracktoolkit-plan` | Linux B1, **capacity 1, pinned** (see `main.bicep` comment and `server/lib/social-cache.js`) |
| Web app | `tracktoolkit` | `https://tracktoolkit.azurewebsites.net`, Node 22 LTS, `node server/index.js`, health check `/health` |
| Postgres | `tracktoolkit-pg` | Flexible Server, PG 17, Burstable B1ms, 32 GB, 7-day backups |
| Databases | `tracktoolkit`, `tracktoolkit-rehearsal` | prod-to-be (empty until cutover) and the throwaway rehearsal target |
| Key Vault | `tracktoolkit-kv` | RBAC mode; the web app reads secrets by reference |
| Log Analytics | `tracktoolkit-logs` | console, HTTP, app and platform logs, 30-day retention |

## Deploy or update the infrastructure

```bash
# First time: pick a strong password; it is stored in Key Vault as postgres-admin-password.
TT_PARAMS=infra/main.bicepparam TT_PG_ADMIN_PASSWORD='...' infra/deploy.sh
# The live app: read the password back rather than inventing a new one.
TT_PARAMS=infra/main.cutover.bicepparam TT_PG_ADMIN_PASSWORD="$(az keyvault secret show --vault-name tracktoolkit-kv --name postgres-admin-password --query value -o tsv)" infra/deploy.sh
```

`TT_PARAMS` is required. `main.cutover.bicepparam` holds the live app's values;
`main.bicepparam` uses the same app name but sets no domain, so applying it to
the live app breaks sign-in. The script prints an ARM what-if and deploys only
after you type the host it is about to change.

The template replaces the whole app-settings list. Before a run, list what is
set by hand and not in `main.bicep`, and add it back afterwards:
`az webapp config appsettings list -n tracktoolkit -g rg-tracktoolkit --query "[].name" -o tsv`.

Optional environment: `TT_CLIENT_IP` (adds a Postgres firewall rule for your
workstation), `TT_SECRET_*` (writes the matching Key Vault secret; see the
header of `deploy.sh` for the full list).

### Delete protection

`main.bicep` puts a `CanNotDelete` lock on the Postgres server and on the Key
Vault, and turns on vault purge protection. **Purge protection is irreversible
once deployed.** The deployer needs Owner or User Access Administrator to create
the locks. While the Postgres lock exists, deleting a database or a firewall
rule (for example `operator-client-ip`) through ARM is refused; remove the lock
first, then redeploy to restore it.

## Deploy the application

`.github/workflows/azure-deploy.yml`. **It runs on every push to `main`** (PR
#52, 2026-09-22, which replaced DigitalOcean's `deploy_on_push`), so merging to
`main` is deploying. Pushes that only touch `**.md`, `docs/**`, `infra/**`,
`.gitignore` or `LICENSE` skip the run; infrastructure changes go through
`infra/deploy.sh` instead. Manual dispatch stays for redeploys, including
of an older commit on `main` (the `ref` input); any other commit is refused.
It builds on Linux so the
Prisma engine matches the App Service image, runs the Jest suite, builds the
Next.js static export, and ships one zip. Oryx is disabled on the app
(`SCM_DO_BUILD_DURING_DEPLOYMENT=false`), so what the workflow zips is exactly
what runs.

One-time setup for the workflow (already done for this repo, recorded here so
it can be rebuilt): an Entra app registration with a federated credential
whose subject is `repo:cole-hackman@83625748/tracktoolkit@1053639544:environment:azure` (GitHub now issues the subject with the owner and repository ids embedded, so it survives renames), the
`Website Contributor` role on `rg-tracktoolkit`, and the repository variables
`AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`.

## Custom domains

Bindings are declared by the `customHostnames` parameter and stay empty until
DNS points at the app; Azure verifies ownership at bind time and fails
otherwise. Cutover order, per hostname:

1. DNS: `CNAME <host> tracktoolkit.azurewebsites.net` (apex: A record to the
   app's inbound IP plus `TXT asuid.<host> <verification id>`; the id is
   `az webapp show -n tracktoolkit -g rg-tracktoolkit --query customDomainVerificationId`).
2. Redeploy with the hostname in `customHostnames`.
3. `az webapp config ssl create -n tracktoolkit -g rg-tracktoolkit --hostname <host>`
   then `az webapp config ssl bind ... --ssl-type SNI` for the managed cert.

The retired `soundcloudtoolkit.com` hostnames are bound to the same app; the
301 is answered by Express (`LEGACY_REDIRECT_HOSTS`) rather than a separate
Front Door profile, which would cost more per month than the whole app.
