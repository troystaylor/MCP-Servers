# MCP Server Development Checklist

Use this checklist when building a new MCP server for a 3rd party API. Copy the checklist into your server's README or issue tracker and check off items as you go.

---

## 1. Planning

- [ ] Identify the **3rd party API** to wrap
- [ ] **Locate the official API documentation** — bookmark the reference (OpenAPI spec, REST API docs, or developer portal). All endpoint URLs, parameters, response schemas, auth requirements, and error codes must come from this source, not from general knowledge or training data.
- [ ] Review the API docs — note auth method, rate limits, pagination, and error formats
- [ ] Define the **tools** the server will expose (keep them granular and well-scoped)
- [ ] Define any **resources** (URI-addressable data the server exposes for context)
- [ ] Define any **prompts** (reusable prompt templates the server provides)
- [ ] Check the [M365 MCP server catalog](https://learn.microsoft.com/en-us/microsoft-agent-365/tooling-servers-overview) to avoid duplicating built-in functionality if the server will be composed with M365 agents
- [ ] Choose a **server name** (kebab-case, e.g. `my-api-server`)

## 2. Scaffold

- [ ] Create a directory at the workspace root: `<server-name>/`
- [ ] Use `/new-mcp-server` prompt or manually create:
  - `package.json` — `"type": "module"`, pnpm, minimal dependencies
  - `tsconfig.json` — ES2022, Node16 module resolution
  - `src/index.ts` — `McpServer` + `StdioServerTransport` boilerplate
- [ ] Add linting and formatting: Prettier (`.prettierrc`), ESLint config
- [ ] Add npm scripts: `build`, `dev`, `typecheck`, `lint`, `format`
- [ ] Run `cd <server-name> && pnpm install`
- [ ] Verify build: `pnpm build`

## 3. Authentication & Configuration

### 3rd Party API Credentials

- [ ] Determine how the server authenticates with the 3rd party API (API key, OAuth, etc.)
- [ ] Store secrets in environment variables — never hardcode credentials
- [ ] Create a `.env.example` with required variables (no real values)
- [ ] Add `.env` to `.gitignore`
- [ ] Implement a typed config loader (read from `process.env`, fail fast on missing vars)

### MCP Server Authorization (for remote/HTTP servers)

When the server is deployed remotely over HTTP, implement OAuth 2.1 authorization per the [MCP authorization spec](https://modelcontextprotocol.io/specification/latest/basic/authorization):

- [ ] Decide on an **authorization server** (Microsoft Entra ID, Keycloak, Auth0, etc.)
- [ ] Serve a **Protected Resource Metadata (PRM)** document at `/.well-known/oauth-protected-resource` — route returning JSON with `resource`, `authorization_servers`, and `scopes_supported` (see `typescript-sdk/examples/shared/src/authServer.ts` for a reference)
- [ ] Return `401 Unauthorized` with `WWW-Authenticate: Bearer` header including `resource_metadata` URI for unauthenticated requests
- [ ] Implement bearer token validation middleware — verify tokens via introspection or JWT library; always check `aud` matches the server URL (see `typescript-sdk/examples/shared/src/authMiddleware.ts` for a demo reference)
- [ ] Define **scopes** per tool or capability (e.g., `mcp:tools`, `mcp:resources`) — avoid catch-all scopes
- [ ] Support **Dynamic Client Registration (DCR)** if your auth server allows it, or document pre-registration steps
- [ ] Add `.env` vars for auth server config: `AUTH_HOST`, `AUTH_PORT`, `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`
- [ ] **Security hardchecks**:
  - Use short-lived access tokens
  - Enforce HTTPS in production (HTTP only for localhost dev)
  - Never log tokens, authorization headers, or secrets
  - Treat `Mcp-Session-Id` as untrusted input — don't tie authorization to it
  - Return generic error messages to clients; log detailed reasons internally

> **Note**: Authorization is optional for **stdio** servers (local transport). Stdio servers can use environment-based credentials or credentials from 3rd party libraries directly.

## 4. Implement Tools

For each tool:

- [ ] Register with `server.registerTool()` using the `/add-tool` pattern
- [ ] Define input schema with **Zod v4** (`import * as z from 'zod/v4'`)
- [ ] Add `.describe()` to every schema field
- [ ] Add `title` and `description` — clear enough for an LLM to decide when to call it
- [ ] Add `annotations` where appropriate (`readOnlyHint`, `destructiveHint`, `openWorldHint`)
- [ ] Implement the handler:
  - **Verify every endpoint, parameter, and response field against the official API docs** before writing the call — do not guess URLs or field names from memory
  - Call the 3rd party API
  - Return results in `content` array with `type: 'text' as const`
  - Return errors with `isError: true` — don't throw
  - Handle API rate limits, pagination, and timeouts gracefully
- [ ] Keep tool implementations focused — one tool, one action

## 5. Implement Resources (if applicable)

- [ ] Define URI templates for addressable data
- [ ] Implement resource handlers with appropriate MIME types
- [ ] Add resource descriptions for discoverability

## 6. Implement Prompts (if applicable)

- [ ] Define reusable prompt templates with typed arguments
- [ ] Add prompt descriptions for discoverability

## 7. Error Handling & Resilience

- [ ] Validate all user inputs at the boundary (Zod handles this for tool inputs)
- [ ] Map 3rd party API errors to helpful MCP error messages
- [ ] Handle network failures, timeouts, and retries appropriately
- [ ] Never leak API keys, tokens, or internal details in error messages

## 8. Testing

### Manual / Smoke Testing

- [ ] Test each tool manually via the **MCP Inspector** (`npx @modelcontextprotocol/inspector`) or piping JSON-RPC over stdio
- [ ] Verify tool schemas are valid: `pnpm typecheck`
- [ ] Verify the server starts cleanly: `pnpm dev`
- [ ] Test with an actual MCP client (e.g. VS Code, Claude Desktop)

### In-Memory Integration Tests (vitest + InMemoryTransport)

Use `InMemoryTransport.createLinkedPair()` from `@modelcontextprotocol/core` to create a paired client/server in-process — no network, fast feedback:

```typescript
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/core';
import { McpServer } from '@modelcontextprotocol/server';

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = new McpServer({ name: 'test', version: '1.0.0' });
const client = new Client({ name: 'test-client', version: '1.0.0' });
await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

const result = await client.callTool({ name: 'my-tool', arguments: { id: '123' } });
expect(result.content).toEqual([{ type: 'text', text: '...' }]);
```

- [ ] Add `vitest` and `@modelcontextprotocol/client` as dev dependencies
- [ ] Create a test helper that sets up `InMemoryTransport.createLinkedPair()`, connects `McpServer` + `Client`, and returns both (see `typescript-sdk/test/integration/test/helpers/mcp.ts` for a reference)
- [ ] Write integration tests for each tool: valid inputs, missing/invalid arguments, API error scenarios
- [ ] Test `listTools` returns correct schemas and descriptions
- [ ] Test error responses return `isError: true` with helpful messages
- [ ] Add `"test": "vitest run"` script to `package.json`

### HTTP E2E Tests (supertest — for HTTP-deployed servers)

For servers using `NodeStreamableHTTPServerTransport` with Express, use `supertest` to test the HTTP layer without starting a real server:

- [ ] Add `supertest` as a dev dependency
- [ ] Test health check endpoint returns 200
- [ ] Test JSON body parsing and content-type handling
- [ ] Test host header validation (rejects non-localhost in dev)
- [ ] Test PRM metadata route (`/.well-known/oauth-protected-resource`) if auth is implemented
- [ ] Test unauthenticated requests return `401` with correct `WWW-Authenticate` header

### Edge Cases & Security

- [ ] Test with edge cases: empty inputs, invalid IDs, missing required fields
- [ ] Verify no API keys, tokens, or internal details leak in error responses
- [ ] Test rate limit handling and retry behavior

## 9. Documentation

- [ ] Write a `README.md` in the server directory:
  - What API it wraps and why
  - Prerequisites (API keys, accounts)
  - Setup instructions (`pnpm install`, `.env` config)
  - Available tools with descriptions and example usage
  - Available resources and prompts (if any)
- [ ] Add an MCP client config example (e.g. `mcp.json` snippet for VS Code)

## 10. Transport & Deployment

- [ ] **Stdio** (default for local dev) — works with CLI-based MCP clients
  - Ensure `"bin"` entry in `package.json` points to `./build/index.js`
  - Add shebang `#!/usr/bin/env node` to built entry point if needed
- [ ] **HTTP** (required for remote/Azure deployment) — use `NodeStreamableHTTPServerTransport` (from `@modelcontextprotocol/node`) with Express
  - Configure CORS, health check endpoint
  - Add PRM metadata route and bearer token validation middleware for OAuth 2.1 authorization
  - Manage session-to-transport mapping for stateful connections

### Azure Deployment

Choose the hosting model based on whether the server needs stateful sessions:

#### Azure Container Apps (recommended — stateful)

Best for servers that need persistent connections, session state, or long-running operations.

- [ ] Add a `Dockerfile` (Node.js base image, copy built output)
- [ ] Add `azure.yaml` for Azure Developer CLI (`azd`) deployment
- [ ] Add Bicep/Terraform for infra: Container Apps environment + Container Registry
- [ ] Deploy: `azd up` (provisions infra + deploys in one command)
- [ ] Configure ingress as external with target port matching your Express server
- [ ] Use **managed identity** for backend Azure resources (Key Vault, databases)
- [ ] Store secrets in **Azure Key Vault**, referenced via Container Apps secrets
- [ ] Enable **Application Insights** for monitoring
- [ ] Verify health: `curl https://<app-url>/health`
- [ ] Add MCP client config: `{ "type": "http", "url": "https://<app-url>/" }`
- Sample: [Azure-Samples/mcp-container-ts](https://github.com/Azure-Samples/mcp-container-ts)
- Docs: https://learn.microsoft.com/azure/developer/ai/build-mcp-server-ts

#### Azure Functions — Flex Consumption (alternative — stateless)

Best for lightweight, scale-to-zero servers where cost optimization matters more than session persistence.

- [ ] Add `host.json` with `"configurationProfile": "mcp-custom-handler"` — no code changes needed
- [ ] Deploy to Flex Consumption plan via `azd up` or Azure portal
- [ ] Enable built-in App Service auth (implements MCP authorization spec automatically)
- [ ] Register in **Azure API Center** for organizational discoverability
- **Constraint**: Stateless streamable-http only — no persistent SSE sessions
- Sample: [Azure-Samples/mcp-sdk-functions-hosting-node](https://github.com/Azure-Samples/mcp-sdk-functions-hosting-node)
- Docs: https://learn.microsoft.com/azure/azure-functions/self-hosted-mcp-servers

## 11. Agent 365 Enterprise (if applicable)

Skip this section if the server is not being deployed to Agent 365.

- [ ] Add enterprise packages:
  ```
  pnpm add @microsoft/agents-a365-tooling @microsoft/agents-a365-runtime @microsoft/agents-a365-observability
  ```
- [ ] **Registration**: Use `McpToolServerConfigurationService` to read `ToolingManifest.json`
- [ ] **Authentication**: Set up Entra-backed auth via `@microsoft/agents-a365-runtime` (OBO or agentic identity)
- [ ] **Observability**: Configure `ObservabilityManager` with all three scopes:
  - `InvokeAgentScope` — wraps agent invocations
  - `ExecuteToolScope` — wraps tool calls
  - `InferenceScope` — wraps LLM calls
  - `BaggageBuilder` — set `tenantId`, `agentId`, `correlationId`
- [ ] Add `.env` vars: `ENABLE_OBSERVABILITY=true`, `ENABLE_A365_OBSERVABILITY_EXPORTER=true`
- [ ] **Notifications** (if needed): Add `@microsoft/agents-a365-notifications` with handlers for relevant event types
- [ ] Test locally with mock tooling server: `a365 develop start-mock-tooling-server`
- [ ] Register via the Agent 365 CLI or MCP Management Server

## 12. Versioning & CI

- [ ] Set an initial version in `package.json` (e.g. `"0.1.0"`)
- [ ] Add a `CHANGELOG.md` or use [changesets](https://github.com/changesets/changesets) for release tracking
- [ ] Add a CI workflow (GitHub Actions) with steps: install → build → typecheck → lint → test
- [ ] Pin Node.js version in CI to match `engines` field

## 13. Certification (if applicable)

Skip this section unless the server will be published for broad M365/Copilot availability. The certification process is still evolving.

- [ ] Ensure publisher eligibility (verified in Microsoft Partner Center)
- [ ] Prepare packaging: OpenAPI definition, auth config, metadata, `intro.md`
- [ ] Implement required auth (OAuth 2.0 preferred)
- [ ] Ensure all three observability scopes emit required telemetry
- [ ] Complete responsible AI review (safety testing for normal, edge-case, and adversarial scenarios)
- [ ] Submit through Partner Center under "Microsoft 365 and Copilot – Power Platform Connector"
- [ ] Plan for post-certification maintenance (resubmit for changes, monitor telemetry)

---

## Quick Reference

| Action | Command / Prompt |
|--------|-----------------|
| Scaffold a new server | `/new-mcp-server` |
| Add a tool | `/add-tool` |
| Build | `pnpm build` |
| Dev mode (watch) | `pnpm dev` |
| Type check | `pnpm typecheck` |
| Run tests | `pnpm test` |
| Lint & format | `pnpm lint` / `pnpm format` |
| Install deps | `pnpm install` |
| Deploy to Azure | `azd up` |
| MCP expert help | `@mcp` |
