# ServiceNow MCP Server

An MCP server that wraps multiple ServiceNow REST APIs, providing 42 tools across CRUD operations, aggregate reporting, attachment management, Service Catalog access, change management, knowledge base search, CSM case/account/contact/order management, incident and problem management, service request tracking, Flow Designer integration, data import, and batch operations.

Deployed to **Azure Container Apps** with OAuth 2.0 dynamic discovery (MCP authorization spec) and **Agent 365 observability** tracing.

## Tools (42)

### Table API

| Tool | Description |
|------|-------------|
| `list_records` | Query records with filtering, pagination, and field selection |
| `get_record` | Retrieve a single record by `sys_id` |
| `create_record` | Insert a new record |
| `update_record` | Patch fields on an existing record |
| `delete_record` | Delete a record by `sys_id` |

### Aggregate API

| Tool | Description |
|------|-------------|
| `aggregate_records` | Compute count, avg, min, max, sum on a table with optional group-by |

### Attachment API

| Tool | Description |
|------|-------------|
| `list_attachments` | List attachment metadata for a record or matching a query |
| `get_attachment` | Get metadata for a single attachment by `sys_id` |
| `delete_attachment` | Delete an attachment by `sys_id` |
| `upload_attachment` | Upload a base64-encoded file attachment to a record |

### Service Catalog API

| Tool | Description |
|------|-------------|
| `list_catalog_items` | Search and browse Service Catalog items |
| `get_catalog_item` | Get full details for a catalog item including form variables |
| `order_catalog_item` | Order a catalog item with quantity and variable values |

### Change Management API

| Tool | Description |
|------|-------------|
| `create_change_request` | Create a standard, normal, or emergency change request |
| `get_change_request` | Retrieve a change request by `sys_id` |
| `update_change_request` | Update fields on an existing change request |
| `check_change_conflict` | Check for scheduling conflicts on a change request |
| `list_change_tasks` | List change tasks for a change request |

### Knowledge Management API

| Tool | Description |
|------|-------------|
| `search_knowledge_articles` | Search knowledge base articles by keyword |
| `get_knowledge_article` | Retrieve full article content by `sys_id` |

### CSM Case API *(requires CSM plugin)*

| Tool | Description |
|------|-------------|
| `create_csm_case` | Create a customer service case |
| `get_csm_case` | Retrieve a case by `sys_id` |
| `update_csm_case` | Update an existing case |

### CSM Account & Contact APIs *(requires CSM plugin)*

| Tool | Description |
|------|-------------|
| `list_csm_accounts` | List customer accounts with filtering |
| `get_csm_account` | Retrieve a single account by `sys_id` |
| `list_csm_contacts` | List contacts with filtering and account scoping |
| `get_csm_contact` | Retrieve a single contact by `sys_id` |

### CSM Order API *(requires CSM plugin)*

| Tool | Description |
|------|-------------|
| `create_csm_order` | Create a customer service order |
| `get_csm_order` | Retrieve an order by `sys_id` |

### Import Set API

| Tool | Description |
|------|-------------|
| `import_set_insert` | Insert a record into an Import Set staging table for transformation |

### Incident Management

| Tool | Description |
|------|-------------|
| `create_incident` | Create a new IT incident with category, impact, urgency, and assignment |
| `resolve_incident` | Resolve an incident with close code and resolution notes |

### Problem Management

| Tool | Description |
|------|-------------|
| `create_problem` | Create a Problem record to investigate root cause of incidents |
| `get_problem` | Retrieve a Problem record by `sys_id` or problem number |
| `update_problem` | Update state, root cause, workaround, or assignment on a Problem |

### Service Request Management

| Tool | Description |
|------|-------------|
| `list_requests` | List Service Requests (`sc_request`) with filtering by state or user |
| `get_request_item` | Retrieve a Requested Item (`sc_req_item`) by `sys_id` |
| `list_request_items` | List Requested Items with filtering by request, catalog item, or stage |

### Flow Designer

| Tool | Description |
|------|-------------|
| `execute_flow` | Trigger a Flow Designer flow or subflow by scope and name |

### Batch API

| Tool | Description |
|------|-------------|
| `batch_api` | Execute multiple REST API requests in a single round-trip (max 20) |

Table API tools support `display_value` to toggle between raw DB values and human‑readable labels.

## Architecture

```
src/
├── server.ts          # McpServer factory — 42 tool registrations
├── http.ts            # Express HTTP transport with session management
├── auth.ts            # OAuth 2.0 AS (better-auth + MCP plugin)
├── observability.ts   # Agent 365 OpenTelemetry tracing
└── index.ts           # Stdio transport entry point
```

- **server.ts** — Creates an `McpServer` instance with all 42 tools. Each tool handler is automatically wrapped with `ExecuteToolScope` for observability tracing.
- **http.ts** — Express 5 entry point for remote deployment. Manages per-session transports, mounts OAuth routes, and wraps each request in `InvokeAgentScope` with `BaggageBuilder` context propagation.
- **auth.ts** — Full OAuth 2.0 authorization server implementing the MCP auth spec: Protected Resource Metadata (RFC 9728), Authorization Server Metadata (RFC 8414), Dynamic Client Registration, PKCE, and bearer token validation.
- **observability.ts** — Initializes `@microsoft/agents-a365-observability` with `ObservabilityManager` and provides `instrumentServer()` which monkey-patches `registerTool` to trace all tool calls automatically.

## Prerequisites

- Node.js >= 20
- pnpm (workspace root handles install)
- A ServiceNow instance with an OAuth application registered in the Application Registry
- The ServiceNow instance URL is hard-coded to `https://dev300384.service-now.com`

## Setup

1. Copy the example env file and fill in your credentials:

   ```bash
   cp .env.example .env
   ```

2. Install dependencies (from the workspace root):

   ```bash
   pnpm install
   ```

3. Build:

   ```bash
   pnpm --filter servicenow-mcp-server build
   ```

4. Run tests:

   ```bash
   pnpm --filter servicenow-mcp-server test
   ```

## Testing

The server has **85 tests** (75 unit + 10 integration) with 100% tool coverage.

### Test Structure

```
test/
├── server.test.ts        # 75 unit tests for all 42 tools
└── integration.test.ts   # 10 integration tests including E2E OAuth
```

### Unit Tests (test/server.test.ts)

**75 tests** organized into groups:

- **Basic CRUD operations** — All 42 tools tested with mock API responses
- **Response content verification** — Validates tool outputs match expected data structures
- **Query parameter construction** — Tests filtering, pagination, sorting, field selection
- **Conditional logic** — Validates display_value, error handling, optional parameters
- **URL encoding** — Tests special characters in sys_id and query parameters
- **Batch API details** — Validates batch request payload structure and serviced_requests array
- **Knowledge API query parameters** — Tests keyword encoding and pagination
- **Flow Designer polling** — Validates async flow execution with status checking

**Test pattern:**
- Uses `vitest` with `InMemoryTransport.createLinkedPair()` for client-server communication
- Mock API responses via `vi.fn()` per-test for precise control
- No real ServiceNow API calls — fully isolated unit tests

**Run unit tests only:**
```bash
npx vitest run test/server.test.ts
```

### Integration Tests (test/integration.test.ts)

**10 tests** validating the full OAuth 2.0 + MCP stack:

1. **Protected Resource Metadata (PRM)** — Validates RFC 9728 `.well-known/oauth-protected-resource/mcp` endpoint
2. **Authorization Server Metadata** — Validates RFC 8414 `.well-known/oauth-authorization-server` endpoint
3. **Dynamic Client Registration** — Tests client registration with redirect URIs
4. **Authorization endpoint** — Validates PKCE code_challenge handling
5. **Token exchange** — Tests authorization_code grant with code_verifier
6. **Bearer token validation** — Tests authenticated `/mcp` endpoint access
7. **Invalid token rejection** — Validates 401 on missing/invalid tokens
8. **Session management** — Tests session creation and termination
9. **Health check** — Validates `/health` endpoint
10. **End-to-end OAuth flow** — Full DCR → PKCE → authorize → sign-in → token exchange → authenticated MCP call

**E2E OAuth flow test details:**
- Starts local HTTP server on random port
- Registers client via Dynamic Client Registration
- Generates PKCE code_verifier and code_challenge
- Follows authorization redirect chain (authorize → sign-in → callback)
- Exchanges authorization code for access token
- Makes authenticated MCP `initialize` call with Bearer token
- Parses Server-Sent Events (SSE) response for JSON-RPC result

**Run integration tests only:**
```bash
npx vitest run test/integration.test.ts
```

### Run all tests

```bash
pnpm test
# or
npx vitest run
```

**Note:** Integration tests spawn background HTTP servers. If tests timeout, kill stale node processes:

```bash
# PowerShell
Get-Process -Name "node" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match "http\.js" } | Stop-Process -Force

# Bash
pkill -f "node.*http.js"
```

### Test Configuration

Tests use `vitest.config.js`:
- `fileParallelism: false` — Prevents port conflicts in integration tests
- `testTimeout: 30000` — 30s timeout for HTTP server startup
- `hookTimeout: 30000` — 30s timeout for setup/teardown

### Coverage

All 42 tools are tested:
- ✅ Table API (5 tools)
- ✅ Aggregate API (1 tool)
- ✅ Attachment API (4 tools)
- ✅ Service Catalog API (3 tools)
- ✅ Change Management API (5 tools)
- ✅ Knowledge Management API (2 tools)
- ✅ CSM Case API (3 tools)
- ✅ CSM Account & Contact APIs (4 tools)
- ✅ CSM Order API (2 tools)
- ✅ Import Set API (1 tool)
- ✅ Incident Management (2 tools)
- ✅ Problem Management (3 tools)
- ✅ Service Request Management (3 tools)
- ✅ Flow Designer (1 tool)
- ✅ Batch API (1 tool)
- ✅ CMDB Identify & Reconcile (2 tools)

## Usage

### Stdio transport (local)

For local use with VS Code, Claude Desktop, or other MCP clients:

```bash
SERVICENOW_USERNAME=admin \
SERVICENOW_PASSWORD=secret \
SERVICENOW_CLIENT_ID=your-client-id \
SERVICENOW_CLIENT_SECRET=your-client-secret \
node dist/index.js
```

### HTTP transport (remote)

For remote deployment with OAuth 2.0 dynamic discovery:

```bash
MCP_SERVER_URL=https://your-server.azurecontainerapps.io \
BETTER_AUTH_SECRET=your-pinned-secret \
SERVICENOW_USERNAME=admin \
SERVICENOW_PASSWORD=secret \
SERVICENOW_CLIENT_ID=your-client-id \
SERVICENOW_CLIENT_SECRET=your-client-secret \
node dist/http.js
```

### VS Code / Copilot MCP config (stdio)

```json
{
  "mcpServers": {
    "servicenow": {
      "command": "node",
      "args": ["<path-to>/ServiceNow/dist/index.js"],
      "env": {
        "SERVICENOW_USERNAME": "",
        "SERVICENOW_PASSWORD": "",
        "SERVICENOW_CLIENT_ID": "",
        "SERVICENOW_CLIENT_SECRET": ""
      }
    }
  }
}
```

### VS Code / Copilot MCP config (remote HTTP)

```json
{
  "mcpServers": {
    "servicenow": {
      "url": "https://your-server.azurecontainerapps.io/mcp"
    }
  }
}
```

The client will discover the OAuth authorization server automatically via the Protected Resource Metadata endpoint and handle the full OAuth flow (Dynamic Client Registration → PKCE authorization → token exchange).

### Copilot Studio

To connect the deployed server to a Copilot Studio agent:

1. Open your agent in [Copilot Studio](https://copilotstudio.microsoft.com)
2. Go to **Actions** → **Add an action** → **MCP Server**
3. Select **Streamable HTTP** as the transport
4. Enter the MCP endpoint URL:
   ```
   https://ca-servicenow-7tin6dfwl3shu.wittygrass-bed744d3.eastus.azurecontainerapps.io/mcp
   ```
5. For authentication, select **OAuth 2.0 (Dynamic discovery)**
6. Copilot Studio will automatically:
   - Discover the authorization server via `/.well-known/oauth-protected-resource/mcp`
   - Register a client via Dynamic Client Registration
   - Complete the PKCE authorization code flow
   - Present the available tools as actions in your agent

### Foundry Agents (Agent 365)

For agents built with `@microsoft/agents-a365-tooling`, this server includes a [ToolingManifest.json](ToolingManifest.json) for automatic discovery:

```typescript
import { addToolServersToAgent } from '@microsoft/agents-a365-tooling';

// Register all MCP servers from the manifest
await addToolServersToAgent(agent);
```

Set `MCP_PLATFORM_ENDPOINT` to the tooling gateway URL, or use the mock tooling server for local development:

```bash
a365 develop start-mock-tooling-server
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SERVICENOW_USERNAME` | Yes | ServiceNow user with Table API access |
| `SERVICENOW_PASSWORD` | Yes | Password for the user |
| `SERVICENOW_CLIENT_ID` | Yes | OAuth client ID from ServiceNow Application Registry |
| `SERVICENOW_CLIENT_SECRET` | Yes | OAuth client secret |
| `MCP_PORT` | No | HTTP transport port (default: 3000) |
| `MCP_SERVER_URL` | HTTP only | External HTTPS URL for OAuth metadata discovery |
| `BETTER_AUTH_SECRET` | HTTP only | Secret for OAuth session signing — pin to a stable value for session persistence across container restarts |
| `ENABLE_A365_OBSERVABILITY_EXPORTER` | No | Set to `true` to export telemetry to the Agent 365 observability service |
| `A365_OBSERVABILITY_LOG_LEVEL` | No | SDK log level: `none` (default), `info`, `warn`, `error`, or `info\|warn\|error` |
| `TENANT_ID` | A365 exporter | Azure Entra tenant ID |
| `AGENT_BLUEPRINT_ID` | A365 exporter | Entra app registration ID for the agent blueprint |
| `AGENT_BLUEPRINT_CLIENT_SECRET` | A365 exporter | Client secret for the agent blueprint |

> **Note:** The ServiceNow instance URL (`https://dev300384.service-now.com`) is hard-coded in the server. This is required because the Copilot Studio MCP connector does not allow passing additional parameters when using OAuth 2.0 Dynamic Discovery.

## Authentication

### ServiceNow API authentication

Uses **OAuth 2.0 Password Grant** to authenticate with ServiceNow. Set `SERVICENOW_CLIENT_ID` and `SERVICENOW_CLIENT_SECRET` from an OAuth application registered in the ServiceNow Application Registry. Tokens are cached and refreshed automatically before expiry.

### MCP client authentication (HTTP transport)

The HTTP transport (`dist/http.js`) implements the **MCP authorization spec** so that MCP clients (Copilot Studio, VS Code, etc.) authenticate before calling tools:

- **Protected Resource Metadata** (RFC 9728) at `/.well-known/oauth-protected-resource/mcp`
- **OAuth Authorization Server Metadata** (RFC 8414) at `/.well-known/oauth-authorization-server`
- **Dynamic Client Registration** at `/api/auth/mcp/register`
- **Authorization endpoint** at `/api/auth/mcp/authorize`
- **Token endpoint** at `/api/auth/mcp/token`
- **Bearer token validation** on all `/mcp` endpoints
- **PKCE** with S256 code challenge method
- **Rate limiting** on all `/api/auth/*` endpoints (30 req/min) and `/sign-in` (10 req/min) via `express-rate-limit`

The `BETTER_AUTH_SECRET` environment variable should be pinned to a stable value so that sessions persist across container restarts. If unset, a random secret is generated on each startup.

## Observability

The server integrates `@microsoft/agents-a365-observability` for OpenTelemetry-based tracing, required for Agent 365 store publishing.

### Scopes

| Scope | Where | What it traces |
|-------|-------|----------------|
| `InvokeAgentScope` | `http.ts` POST /mcp handler | Each MCP request (session ID, response status) |
| `ExecuteToolScope` | `server.ts` via `instrumentServer()` | Every tool call (tool name, arguments, response) |

`InferenceScope` is not used — this server does not make LLM calls.

### Baggage propagation

`BaggageBuilder.setRequestContext()` is called per-request to propagate `tenantId`, `agentId`, and `correlationId` (session ID) across all spans.

### Enabling production export

Set `ENABLE_A365_OBSERVABILITY_EXPORTER=true` and configure a token resolver if your deployment requires authenticated telemetry export. Without this flag, traces are generated but not exported.

## Azure Deployment

The server is deployed to **Azure Container Apps** with a multi-stage Docker build.

### Infrastructure

| Resource | Name |
|----------|------|
| Container App | `ca-servicenow-7tin6dfwl3shu` |
| Container Registry | `acrmcp7tin6dfwl3shu.azurecr.io` |
| Resource Group | `rg-dev` |
| Region | East US |

### Endpoints

| Path | Auth | Description |
|------|------|-------------|
| `POST /mcp` | Bearer | MCP protocol — initialize sessions and send JSON-RPC messages |
| `GET /mcp` | Bearer | SSE stream for server-to-client notifications |
| `DELETE /mcp` | Bearer | Session termination |
| `GET /health` | None | Health check (`{"status":"ok","server":"servicenow-mcp-server"}`) |
| `GET /.well-known/oauth-protected-resource/mcp` | None | RFC 9728 Protected Resource Metadata |
| `GET /.well-known/oauth-authorization-server` | None | RFC 8414 Authorization Server Metadata |

### Build and deploy

```bash
# Prepare build context (from workspace root)
Remove-Item -Recurse -Force build-context -ErrorAction SilentlyContinue
New-Item build-context -ItemType Directory | Out-Null
Copy-Item package.json, pnpm-workspace.yaml, pnpm-lock.yaml build-context/
robocopy ServiceNow build-context/ServiceNow /E /XD node_modules dist .git test /XF .env | Out-Null
New-Item build-context/typescript-sdk -ItemType Directory -Force | Out-Null
robocopy typescript-sdk/packages build-context/typescript-sdk/packages /E /XD node_modules dist .git | Out-Null
robocopy typescript-sdk/common build-context/typescript-sdk/common /E /XD node_modules .git | Out-Null

# Build image in ACR
az acr build --registry acrmcp7tin6dfwl3shu -g rg-dev \
  --image servicenow-mcp-server:latest \
  --file ServiceNow/Dockerfile \
  --no-logs build-context/

# Deploy new revision
az containerapp update -n ca-servicenow-7tin6dfwl3shu -g rg-dev \
  --image acrmcp7tin6dfwl3shu.azurecr.io/servicenow-mcp-server:latest \
  --revision-suffix v13

# Clean up
Remove-Item -Recurse -Force build-context
```

### Container secrets

Secrets are stored in the Container App and mapped to environment variables:

| Secret name | Env var |
|-------------|---------|
| `servicenow-username` | `SERVICENOW_USERNAME` |
| `servicenow-password` | `SERVICENOW_PASSWORD` |
| `servicenow-client-id` | `SERVICENOW_CLIENT_ID` |
| `servicenow-client-secret` | `SERVICENOW_CLIENT_SECRET` |
| `better-auth-secret` | `BETTER_AUTH_SECRET` |

## Example Queries

List high-priority open incidents:

```
table: incident
query: active=true^priority=1
fields: number,short_description,state,assigned_to
limit: 5
```

Get a specific change request:

```
table: change_request
sys_id: abc123def456
```

Count incidents by priority:

```
table: incident
query: active=true
count: true
group_by: priority
```

Average reassignment count by assignment group:

```
table: incident
avg_fields: reassignment_count
group_by: assignment_group
```

List attachments on an incident:

```
table_name: incident
table_sys_id: abc123def456
```

Search the Service Catalog for laptops:

```
search: laptop
limit: 5
```

Create an emergency change request:

```
type: emergency
data: {"short_description": "Critical patch deployment", "justification": "Security vulnerability"}
```

Check a change for scheduling conflicts:

```
sys_id: abc123def456
```

Search knowledge base for VPN articles:

```
query: VPN setup
limit: 5
```

Create a CSM case:

```
data: {"short_description": "Billing discrepancy", "account": "<sys_id>", "priority": "2"}
```

Batch two requests in one round-trip:

```
requests:
  - id: "1"
    method: GET
    url: "/api/now/table/incident?sysparm_limit=1"
  - id: "2"
    method: GET
    url: "/api/now/table/change_request?sysparm_limit=1"
```

Create an incident:

```
short_description: Printer on floor 3 is offline
impact: 3
urgency: 2
category: hardware
```

Resolve an incident:

```
sys_id: abc123def456
close_code: Solved (Permanently)
close_notes: Replaced toner cartridge
```

Create a problem for recurring incidents:

```
short_description: Recurring network drops in Building A
impact: 2
urgency: 2
assignment_group: network-ops
```

List open service requests:

```
request_state: approved
limit: 10
```

Trigger a Flow Designer flow:

```
scope: global
flow_name: onboard_new_hire
inputs: {"employee_name": "Jane Doe", "department": "Engineering"}
```

## API Reference

- [ServiceNow Aggregate API](https://www.servicenow.com/docs/r/api-reference/rest-apis/aggregate-api.html)
- [ServiceNow Attachment API](https://www.servicenow.com/docs/r/api-reference/rest-apis/attachment-api.html)
- [ServiceNow Service Catalog API](https://www.servicenow.com/docs/r/api-reference/rest-apis/service-catalog-api.html)
- [ServiceNow Change Management API](https://www.servicenow.com/docs/r/api-reference/rest-apis/change-management-api.html)
- [ServiceNow Knowledge API](https://www.servicenow.com/docs/r/api-reference/rest-apis/knowledge-api.html)
- [ServiceNow Case API (CSM)](https://www.servicenow.com/docs/r/api-reference/rest-apis/case-api.html)
- [ServiceNow Account API](https://www.servicenow.com/docs/r/api-reference/rest-apis/account-api.html)
- [ServiceNow Contact API](https://www.servicenow.com/docs/r/api-reference/rest-apis/contact-api.html)
- [ServiceNow Order API (CSM)](https://www.servicenow.com/docs/r/api-reference/rest-apis/order_csm-api.html)
- [ServiceNow Table API](https://www.servicenow.com/docs/r/api-reference/rest-apis/c_TableAPI.html)
- [ServiceNow Batch API](https://www.servicenow.com/docs/r/api-reference/rest-apis/batch-api.html)
- [ServiceNow Import Set API](https://www.servicenow.com/docs/r/api-reference/rest-apis/import-set-api.html)
- [ServiceNow Flow Designer API](https://www.servicenow.com/docs/r/api-reference/rest-apis/flow-designer-api.html)
- [ServiceNow CMDB API](https://www.servicenow.com/docs/r/api-reference/rest-apis/cmdb-api.html)
- [Encoded Query Strings](https://www.servicenow.com/docs/r/platform-user-interface/c_EncodedQueryStrings.html)
