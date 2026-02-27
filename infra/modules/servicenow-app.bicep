@description('Location for the resource')
param location string

@description('Unique token for resource naming')
param resourceToken string

@description('Tags to apply to all resources')
param tags object

@description('Container Apps Environment resource ID')
param containerAppsEnvironmentId string

@description('Container Registry login server')
param containerRegistryLoginServer string

@description('Container Registry name')
param containerRegistryName string

@description('ServiceNow instance URL')
@secure()
param servicenowInstanceUrl string

@description('ServiceNow username')
@secure()
param servicenowUsername string

@description('ServiceNow password')
@secure()
param servicenowPassword string

@description('ServiceNow auth type')
param servicenowAuthType string

@description('ServiceNow OAuth client ID')
@secure()
param servicenowClientId string

@description('ServiceNow OAuth client secret')
@secure()
param servicenowClientSecret string

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: containerRegistryName
}

var isOAuth = servicenowAuthType == 'oauth'

var baseSecrets = [
  {
    name: 'acr-password'
    value: acr.listCredentials().passwords[0].value
  }
  {
    name: 'servicenow-instance-url'
    value: servicenowInstanceUrl
  }
  {
    name: 'servicenow-username'
    value: servicenowUsername
  }
  {
    name: 'servicenow-password'
    value: servicenowPassword
  }
]

var oauthSecrets = [
  {
    name: 'servicenow-client-id'
    value: servicenowClientId
  }
  {
    name: 'servicenow-client-secret'
    value: servicenowClientSecret
  }
]

var baseEnv = [
  {
    name: 'MCP_PORT'
    value: '3000'
  }
  {
    name: 'NODE_ENV'
    value: 'production'
  }
  {
    name: 'SERVICENOW_INSTANCE_URL'
    secretRef: 'servicenow-instance-url'
  }
  {
    name: 'SERVICENOW_USERNAME'
    secretRef: 'servicenow-username'
  }
  {
    name: 'SERVICENOW_PASSWORD'
    secretRef: 'servicenow-password'
  }
  {
    name: 'SERVICENOW_AUTH_TYPE'
    value: servicenowAuthType
  }
]

var oauthEnv = [
  {
    name: 'SERVICENOW_CLIENT_ID'
    secretRef: 'servicenow-client-id'
  }
  {
    name: 'SERVICENOW_CLIENT_SECRET'
    secretRef: 'servicenow-client-secret'
  }
]

resource servicenowApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: 'ca-servicenow-${resourceToken}'
  location: location
  tags: union(tags, {
    'azd-service-name': 'servicenow'
  })
  properties: {
    managedEnvironmentId: containerAppsEnvironmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: containerRegistryLoginServer
          username: acr.listCredentials().username
          passwordSecretRef: 'acr-password'
        }
      ]
      secrets: isOAuth ? union(baseSecrets, oauthSecrets) : baseSecrets
    }
    template: {
      containers: [
        {
          name: 'servicenow-mcp-server'
          // Placeholder image — replaced during deployment
          image: '${containerRegistryLoginServer}/servicenow-mcp-server:latest'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: isOAuth ? union(baseEnv, oauthEnv) : baseEnv
        }
      ]
      scale: {
        minReplicas: 0
        maxReplicas: 3
        rules: [
          {
            name: 'http-scale'
            http: {
              metadata: {
                concurrentRequests: '50'
              }
            }
          }
        ]
      }
    }
  }
}

output fqdn string = 'https://${servicenowApp.properties.configuration.ingress.fqdn}'
