// Track Toolkit — Azure infrastructure (resource-group scope).
//
// One App Service (Linux, Node) serves BOTH the Express API and the Next.js
// static export from the same origin, one Postgres Flexible Server holds the
// data, and one Key Vault holds every secret. Deploy with infra/deploy.sh;
// application code ships via .github/workflows/azure-deploy.yml.
//
// Design notes are in docs/internal/MIGRATION.md ("Work item 1"). The short version:
//   * App Service over Container Apps: no registry, no Dockerfile, single
//     instance is the default, health-check restarts and managed TLS built in.
//   * Same-origin over Static Web Apps: session cookie can drop from
//     SameSite=None to Lax, the CORS allowlist collapses to one origin, and
//     the api.* subdomain disappears from the OAuth redirect URI.

targetScope = 'resourceGroup'

@description('Short name used as the prefix for every resource.')
@minLength(3)
@maxLength(20)
param baseName string = 'tracktoolkit'

@description('Azure region for every resource.')
param location string = resourceGroup().location

@description('Postgres administrator login.')
param postgresAdminLogin string = 'tracktoolkit_admin'

@description('Postgres administrator password. Never committed; passed on the CLI and stored in Key Vault by deploy.sh.')
@secure()
param postgresAdminPassword string

@description('Object id of the person/pipeline running the deployment. Gets Key Vault Secrets Officer so it can write secrets.')
param deployerObjectId string

@description('Create the deployer\'s Key Vault Secrets Officer assignment. deploy.sh sets this false when an equivalent assignment already exists (e.g. granted in the portal), because ARM rejects a duplicate under a different name.')
param assignDeployerKvRole bool = true

@description('Optional public IP allowed through the Postgres firewall for pg_dump/pg_restore. Empty string skips the rule.')
param clientIp string = ''

@description('Custom hostnames to bind to the web app. Empty until DNS points here — bindings fail verification otherwise. See docs/internal/MIGRATION.md work item 4.')
param customHostnames array = []

@description('Attach the App Service managed certificate named after each custom hostname (must already exist). False only for the first deploy of a brand-new hostname.')
param bindManagedCertificates bool = false

@description('Value of the NODE_ENV app setting.')
param nodeEnv string = 'production'

@description('Primary public origin of the app. Same origin serves the API and the frontend.')
param appUrl string = 'https://${baseName}.azurewebsites.net'

@description('Comma-separated CORS / Origin allowlist. Same-origin means this is normally just appUrl.')
param appUrls string = appUrl

@description('OAuth redirect URI registered with SoundCloud. Must match the SoundCloud app registration exactly.')
param soundcloudRedirectUri string = '${appUrl}/api/auth/callback'

@description('Comma-separated SoundCloud numeric user ids allowed into /api/admin/*. Empty fails closed.')
param adminIds string = ''

@description('Set to false on the parallel/rehearsal stack so a second growth scheduler never acts on real users.')
param growthAutocheck bool = false

@description('SameSite attribute for the session cookie. Same-origin hosting allows lax; the old split-origin stack needed none.')
@allowed(['lax', 'none', 'strict'])
param sessionCookieSameSite string = 'lax'

@description('Comma-separated legacy hostnames that Express 301/308-redirects to appUrl (the soundcloudtoolkit.com retirement). Empty disables the middleware. See docs/internal/MIGRATION.md work item 4.')
param legacyRedirectHosts string = ''

var planName = '${baseName}-plan'
var webAppName = baseName
var kvName = '${baseName}-kv'
var pgServerName = '${baseName}-pg'
var logsName = '${baseName}-logs'

// Built-in role ids (constant across tenants).
var kvSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'
var kvSecretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logsName
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    features: { enableLogAccessUsingOnlyResourcePermissions: true }
  }
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------
resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: kvName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 30
    // Irreversible: Azure never lets purge protection be turned off again, and
    // the vault name stays taken for the 30 days above after a delete.
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
  }
}

// Removed on purpose only (az lock delete, Owner or User Access Administrator).
// A locked resource also makes `az group delete` on the group fail, so the
// group itself carries no lock.
resource kvDeleteLock 'Microsoft.Authorization/locks@2020-05-01' = {
  name: '${kvName}-no-delete'
  scope: kv
  properties: {
    level: 'CanNotDelete'
    notes: 'Holds the key that decrypts every stored SoundCloud token.'
  }
}

resource deployerSecretsOfficer 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (assignDeployerKvRole) {
  name: guid(kv.id, deployerObjectId, kvSecretsOfficerRoleId)
  scope: kv
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsOfficerRoleId)
    principalId: deployerObjectId
    principalType: 'User'
  }
}

resource webAppSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, webApp.id, kvSecretsUserRoleId)
  scope: kv
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsUserRoleId)
    principalId: webApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: pgServerName
  location: location
  sku: { name: 'Standard_B1ms', tier: 'Burstable' }
  properties: {
    version: '17'
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    storage: { storageSizeGB: 32, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    network: { publicNetworkAccess: 'Enabled' }
    authConfig: { passwordAuth: 'Enabled', activeDirectoryAuth: 'Disabled' }
  }
}

// Covers child resources too: databases and firewall rules cannot be deleted
// through ARM while it exists (SQL DROP DATABASE is not affected).
resource pgDeleteLock 'Microsoft.Authorization/locks@2020-05-01' = {
  name: '${pgServerName}-no-delete'
  scope: pg
  properties: {
    level: 'CanNotDelete'
    notes: 'Production database. Server backups are deleted with the server.'
  }
}

// The future production database. Empty until the cutover in
// docs/azure-db-cutover.md restores into it.
resource pgDbProd 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: pg
  name: 'tracktoolkit'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

// Throwaway rehearsal target for the migration dry run. Safe to drop and
// recreate at any time; nothing points at it except the parallel stack.
resource pgDbRehearsal 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: pg
  name: 'tracktoolkit-rehearsal'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

// 0.0.0.0 is Azure's sentinel for "services inside Azure", which is how the
// App Service outbound IPs reach the server without VNet integration.
// Follow-up (docs/internal/MIGRATION.md): move to a private endpoint once the stack is live.
resource pgAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: pg
  name: 'AllowAllAzureServicesAndResourcesWithinAzureIps'
  properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' }
}

resource pgAllowClient 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = if (!empty(clientIp)) {
  parent: pg
  name: 'operator-client-ip'
  properties: { startIpAddress: clientIp, endIpAddress: clientIp }
}

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------
resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: planName
  location: location
  kind: 'linux'
  sku: { name: 'B1', tier: 'Basic', capacity: 1 }
  properties: {
    reserved: true // Linux
    // capacity is pinned to 1 and must stay there. The durable library cache
    // (server/lib/social-cache.js, header comment on invalidation marks) keeps
    // per-process invalidation state; a second instance can republish a
    // pre-mutation snapshot as complete. Basic tier has no autoscale rules,
    // and elasticScaleEnabled below keeps the newer automatic scaling off.
    elasticScaleEnabled: false
    perSiteScaling: false
    zoneRedundant: false
  }
}

resource webApp 'Microsoft.Web/sites@2023-12-01' = {
  name: webAppName
  location: location
  kind: 'app,linux'
  identity: { type: 'SystemAssigned' }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    siteConfig: {
      linuxFxVersion: 'NODE|22-lts'
      appCommandLine: 'node server/index.js'
      alwaysOn: true
      http20Enabled: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      healthCheckPath: '/health'
      // One worker, deliberately. Two things break at more than one:
      //   - the library cache's invalidation marks are per-process
      //     (server/lib/social-cache.js), so a second instance can republish a
      //     pre-mutation snapshot as 'complete';
      //   - the revocation classifier in server/lib/soundcloud-client.js
      //     decides "revoked" by comparing the presented refresh token to the
      //     stored one, and only the in-process refresh mutex guarantees the
      //     row has been updated first. Across processes the loser of a
      //     simultaneous refresh reads a pre-update row and disconnects a live
      //     user, which starts the six-day account-deletion clock.
      // The second one destroys accounts, so raising this needs a
      // database-side guard on the rotation first — not just more memory.
      numberOfWorkers: 1
      appSettings: [
        // Code is built by the GitHub Actions workflow and shipped as a zip
        // that already contains node_modules and frontend-UI/out. Do not let
        // Oryx rebuild it on the box.
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'false' }
        { name: 'WEBSITE_RUN_FROM_PACKAGE', value: '0' }
        { name: 'NODE_ENV', value: nodeEnv }
        { name: 'APP_URL', value: appUrl }
        { name: 'APP_URLS', value: appUrls }
        { name: 'SOUNDCLOUD_REDIRECT_URI', value: soundcloudRedirectUri }
        { name: 'ADMIN_IDS', value: adminIds }
        { name: 'GROWTH_AUTOCHECK', value: growthAutocheck ? 'true' : 'false' }
        { name: 'SESSION_COOKIE_SAMESITE', value: sessionCookieSameSite }
        { name: 'LEGACY_REDIRECT_HOSTS', value: legacyRedirectHosts }
        // Secrets live in Key Vault and slot in here with no code change.
        // The secret NAMES are the contract; deploy.sh documents each one.
        { name: 'DATABASE_URL', value: '@Microsoft.KeyVault(VaultName=${kvName};SecretName=database-url)' }
        { name: 'ENCRYPTION_KEY', value: '@Microsoft.KeyVault(VaultName=${kvName};SecretName=encryption-key)' }
        { name: 'SESSION_SECRET', value: '@Microsoft.KeyVault(VaultName=${kvName};SecretName=session-secret)' }
        { name: 'SOUNDCLOUD_CLIENT_ID', value: '@Microsoft.KeyVault(VaultName=${kvName};SecretName=soundcloud-client-id)' }
        { name: 'SOUNDCLOUD_CLIENT_SECRET', value: '@Microsoft.KeyVault(VaultName=${kvName};SecretName=soundcloud-client-secret)' }
        { name: 'DOWNLOAD_ALLOWLIST', value: '@Microsoft.KeyVault(VaultName=${kvName};SecretName=download-allowlist)' }
      ]
    }
  }
}

resource webAppLogs 'Microsoft.Web/sites/config@2023-12-01' = {
  parent: webApp
  name: 'logs'
  properties: {
    applicationLogs: { fileSystem: { level: 'Information' } }
    httpLogs: { fileSystem: { enabled: true, retentionInDays: 3, retentionInMb: 35 } }
    detailedErrorMessages: { enabled: true }
    failedRequestsTracing: { enabled: false }
  }
}

resource webAppDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-log-analytics'
  scope: webApp
  properties: {
    workspaceId: logs.id
    logs: [
      { category: 'AppServiceConsoleLogs', enabled: true }
      { category: 'AppServiceHTTPLogs', enabled: true }
      { category: 'AppServiceAppLogs', enabled: true }
      { category: 'AppServicePlatformLogs', enabled: true }
    ]
  }
}

// ---------------------------------------------------------------------------
// Custom domains (inert until customHostnames is non-empty)
// ---------------------------------------------------------------------------
// At cutover this list becomes:
//   tracktoolkit.com, www.tracktoolkit.com          (the new canonical + www)
//   soundcloudtoolkit.com, www.soundcloudtoolkit.com, api.soundcloudtoolkit.com
//     (bound here so Express can answer the 301 — see LEGACY_REDIRECT_HOSTS)
// Each needs a CNAME/A record plus an asuid TXT record first, and a managed
// certificate after the binding exists (second deploy or az CLI; see
// infra/README.md "Custom domains").
// App Service accepts one site update at a time; bindings applied in
// parallel fail each other with "another operation is in progress".
// A binding PUT replaces the TLS state, so once a managed certificate exists
// for the hostname it has to be named here or a redeploy silently detaches
// it (that happened on 2026-09-20 and took the site down for six minutes).
// bindManagedCertificates=false is only for the very first deploy of a
// hostname, before `az webapp config ssl create` has run for it.
resource managedCerts 'Microsoft.Web/certificates@2023-12-01' existing = [for host in customHostnames: {
  name: host
}]

@batchSize(1)
resource hostBindings 'Microsoft.Web/sites/hostNameBindings@2023-12-01' = [for (host, i) in customHostnames: {
  parent: webApp
  name: host
  properties: {
    siteName: webApp.name
    hostNameType: 'Verified'
    sslState: bindManagedCertificates ? 'SniEnabled' : 'Disabled'
    thumbprint: bindManagedCertificates ? managedCerts[i].properties.thumbprint : null
  }
}]

// ---------------------------------------------------------------------------
output webAppName string = webApp.name
output webAppHostname string = webApp.properties.defaultHostName
output webAppPrincipalId string = webApp.identity.principalId
output keyVaultName string = kv.name
output postgresHost string = pg.properties.fullyQualifiedDomainName
output postgresAdminLogin string = postgresAdminLogin
output logAnalyticsWorkspaceId string = logs.id
