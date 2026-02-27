@description('Location for the resource')
param location string

@description('Unique token for resource naming')
param resourceToken string

@description('Tags to apply to all resources')
param tags object

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'acrmcp${resourceToken}'
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: true
  }
}

output loginServer string = acr.properties.loginServer
output name string = acr.name
