// Parameters for a stack with no custom domain. NOT the live app's values: those
// are in main.cutover.bicepparam, which uses the same baseName. Secrets are NOT here:
// postgresAdminPassword and deployerObjectId come from the environment that
// infra/deploy.sh sets up. Cutover values live on prep/domain-switch.
using 'main.bicep'

param baseName = 'tracktoolkit'
param nodeEnv = 'production'
param growthAutocheck = false
param sessionCookieSameSite = 'lax'
param adminIds = '472267677'
param customHostnames = []
param legacyRedirectHosts = ''

param postgresAdminPassword = readEnvironmentVariable('TT_PG_ADMIN_PASSWORD')
param deployerObjectId = readEnvironmentVariable('TT_DEPLOYER_OBJECT_ID')
param clientIp = readEnvironmentVariable('TT_CLIENT_IP', '')
param assignDeployerKvRole = bool(readEnvironmentVariable('TT_ASSIGN_DEPLOYER_ROLE', 'true'))
