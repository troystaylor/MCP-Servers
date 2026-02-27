targetScope = 'subscription'

@description('Primary location for all resources')
param location string

@description('Name of the environment (e.g. dev, staging, prod)')
param environmentName string

@description('ServiceNow instance URL')
@secure()
param servicenowInstanceUrl string

@description('ServiceNow username')
@secure()
param servicenowUsername string

@description('ServiceNow password')
@secure()
param servicenowPassword string

@description('ServiceNow auth type: basic or oauth')
param servicenowAuthType string = 'basic'

@description('ServiceNow OAuth client ID (required for oauth auth type)')
@secure()
param servicenowClientId string = ''

@description('ServiceNow OAuth client secret (required for oauth auth type)')
@secure()
param servicenowClientSecret string = ''

var tags = {
  'azd-env-name': environmentName
}

var resourceToken = toLower(uniqueString(subscription().id, environmentName, location))

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: 'rg-${environmentName}'
  location: location
  tags: tags
}

module containerAppsEnv './modules/container-apps-env.bicep' = {
  scope: rg
  params: {
    location: location
    resourceToken: resourceToken
    tags: tags
  }
}

module containerRegistry './modules/container-registry.bicep' = {
  scope: rg
  params: {
    location: location
    resourceToken: resourceToken
    tags: tags
  }
}

module servicenowApp './modules/servicenow-app.bicep' = {
  scope: rg
  params: {
    location: location
    resourceToken: resourceToken
    tags: tags
    containerAppsEnvironmentId: containerAppsEnv.outputs.environmentId
    containerRegistryLoginServer: containerRegistry.outputs.loginServer
    containerRegistryName: containerRegistry.outputs.name
    servicenowInstanceUrl: servicenowInstanceUrl
    servicenowUsername: servicenowUsername
    servicenowPassword: servicenowPassword
    servicenowAuthType: servicenowAuthType
    servicenowClientId: servicenowClientId
    servicenowClientSecret: servicenowClientSecret
  }
}

output AZURE_CONTAINER_REGISTRY_ENDPOINT string = containerRegistry.outputs.loginServer
output AZURE_CONTAINER_REGISTRY_NAME string = containerRegistry.outputs.name
output SERVICE_SERVICENOW_ENDPOINTS array = [servicenowApp.outputs.fqdn]
