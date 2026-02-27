# MCP Servers

Enterprise-grade [Model Context Protocol (MCP)](https://modelcontextprotocol.io) servers wrapping 3rd party REST APIs. Each server is deployed to **Azure Container Apps** with OAuth 2.0 authorization, OpenTelemetry observability, and support for **Microsoft Agent 365** workloads.

## Available Servers

### [ServiceNow](ServiceNow/)

**42 tools** — Table CRUD, Aggregate, Attachment, Service Catalog, Change Management, Knowledge, CSM (Case/Account/Contact/Order), Incident, Problem, Service Request, Flow Designer, Batch API, Import Set, and CMDB.

- **Docs**: [ServiceNow/README.md](ServiceNow/README.md)
- **Deployed**: Azure Container Apps
- **Auth**: OAuth 2.0 Password Grant (ServiceNow) + OAuth 2.1 MCP Authorization (client)
- **Observability**: Agent 365 OpenTelemetry tracing
- **Usage**: Stdio (local) or HTTP (remote)

## Architecture

Each MCP server:
- Wraps a **single 3rd party API** end-to-end
- Lives in its own directory with independent package.json
- Uses the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) via npm
- Implements **OAuth 2.0 authorization** per the [MCP auth spec](https://modelcontextprotocol.io/specification/latest/basic/authorization)
- Exposes **OpenTelemetry traces** for `InvokeAgentScope` and `ExecuteToolScope`
- Deploys to **Azure Container Apps** via Docker

## Quick Start

### Local Development (Stdio)

```bash
cd ServiceNow
pnpm install
pnpm build

# Configure credentials in .env
cp .env.example .env
# Edit .env with your ServiceNow credentials

# Run locally with stdio transport
pnpm start
```

Add to your MCP client (VS Code, Claude Desktop, etc.):

```json
{
  "mcpServers": {
    "servicenow": {
      "command": "node",
      "args": ["<path-to>/ServiceNow/dist/index.js"],
      "env": {
        "SERVICENOW_USERNAME": "your-username",
        "SERVICENOW_PASSWORD": "your-password",
        "SERVICENOW_CLIENT_ID": "your-client-id",
        "SERVICENOW_CLIENT_SECRET": "your-client-secret"
      }
    }
  }
}
```

### Remote Deployment (HTTP)

Deploy to Azure Container Apps using the provided infrastructure:

```bash
# Build and push to Azure Container Registry
cd ServiceNow
az acr build --registry <your-acr> \
  --image servicenow-mcp-server:latest \
  --file Dockerfile .

# Deploy to Container App
az containerapp update \
  -n <your-container-app> \
  -g <resource-group> \
  --image <your-acr>.azurecr.io/servicenow-mcp-server:latest
```

See [infra/](infra/) for Bicep templates to provision:
- Azure Container Registry (ACR)
- Container Apps Environment
- Container App with secrets and environment variables

## Testing

Each server includes comprehensive test coverage:

```bash
cd ServiceNow
pnpm test
```

The ServiceNow server has **85 tests** (75 unit + 10 integration) covering all 42 tools plus end-to-end OAuth flows.

## Requirements

- **Node.js** >= 20
- **pnpm** (recommended) or npm
- **Azure CLI** (for deployment)
- **Docker** (for building container images)

## Design Principles

### I. Docs-First
Every tool is built from **official API documentation** — endpoint URLs, parameters, response shapes, auth headers, and error codes. Never rely on general knowledge or training data.

### II. One Server, One API
Each server wraps a single 3rd party API. Servers are self-contained, independently buildable, and independently deployable.

### III. Granular, Auditable Tools
Tools are the atomic unit of work. Each tool performs one action against one endpoint. All tools are traced via OpenTelemetry for enterprise governance.

### IV. Test-First Quality
Every tool must have at least one unit test before shipping. Integration tests verify OAuth flows and transport layers.

### V. Security by Default
Secrets in environment variables. OAuth 2.0 token validation. Bearer auth on all HTTP endpoints. Errors never leak credentials.

### VI. Simplicity (YAGNI)
Build only what's needed. No premature abstraction. Ship small, iterate.

## MCP Authorization

Remote HTTP servers implement the [MCP authorization specification](https://modelcontextprotocol.io/specification/latest/basic/authorization):

- **Protected Resource Metadata (PRM)** — RFC 9728 at `/.well-known/oauth-protected-resource/mcp`
- **Authorization Server Metadata** — RFC 8414 at `/.well-known/oauth-authorization-server`
- **Dynamic Client Registration** — OAuth 2.0 DCR for automatic client onboarding
- **PKCE** — S256 code challenge for authorization code flow
- **Bearer Token Validation** — All `/mcp` endpoints require valid access tokens
- **Scoped Permissions** — Fine-grained access control per tool or resource

## Agent 365 Integration

These servers are designed for **Microsoft Agent 365** enterprise agents:

- **Agentic Authentication** — Agents have their own Entra identity
- **On-Behalf-Of (OBO)** — Delegated user permissions when needed
- **Observability** — `InvokeAgentScope` and `ExecuteToolScope` emit telemetry to Azure Monitor
- **Governance** — IT admins can allow/block servers via the M365 admin center
- **Notifications** — React to email, Word/Excel/PowerPoint comments, and lifecycle events

See [Microsoft Agent 365 documentation](https://learn.microsoft.com/microsoft-agent-365/) for more details.

## Contributing

When adding a new server:

1. Create a directory at the root: `<api-name>/`
2. Follow the structure in [ServiceNow/](ServiceNow/) — `src/`, `test/`, `package.json`, `tsconfig.json`, `Dockerfile`, `README.md`
3. Use `@modelcontextprotocol/sdk` from npm (not a local fork)
4. Write tests for every tool
5. Document all environment variables and setup steps
6. Add deployment instructions for Azure Container Apps

See [.github/SERVER-DEV-CHECKLIST.md](.github/SERVER-DEV-CHECKLIST.md) for a complete checklist.

## License

MIT

## Resources

- [Model Context Protocol Specification](https://modelcontextprotocol.io/specification)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Microsoft Agent 365 Documentation](https://learn.microsoft.com/microsoft-agent-365/)
- [Azure Container Apps Documentation](https://learn.microsoft.com/azure/container-apps/)
