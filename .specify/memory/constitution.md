# MCP Servers Workspace Constitution

## Core Principles

### I. Docs-First
Every tool that calls a 3rd party API must be built from the **official API documentation** — endpoint URLs, parameters, response shapes, auth headers, and error codes. Never rely on general knowledge or training data for API details. Fetch and reference current docs before writing any API call.

### II. One Server, One API
Each MCP server wraps a single 3rd party REST API and lives in its own directory at the workspace root (e.g. `ServiceNow/`). Servers are self-contained, independently buildable, and independently deployable. They share only the MCP TypeScript SDK via pnpm workspace linking.

### III. Granular, Auditable Tools
Tools are the atomic unit of work. Each tool performs one action against one API endpoint. Tool inputs are validated with Zod v4, every schema field has `.describe()`, and errors are returned via `isError: true` — never thrown. Tools must be traceable for enterprise governance (Microsoft Defender, OpenTelemetry).

### IV. Test-First Quality
Every tool must have at least one unit test using `InMemoryTransport` before it ships. Tests mock `fetch` and verify endpoint URLs, HTTP methods, request bodies, and error handling. The test suite must pass before any code is merged. Target: one test per tool minimum, boundary/error tests for complex tools.

### V. Security by Default
Secrets live in environment variables, never in code. Servers support both Basic and OAuth 2.0 auth. Remote HTTP servers implement MCP OAuth 2.1 authorization (PRM metadata, bearer token validation, scoped permissions). Tokens are never logged. Error messages never leak credentials or internal details.

### VI. Simplicity (YAGNI)
Start with the minimum viable set of tools. Add tools when there is a clear use case, not speculatively. Prefer flat, direct implementations over abstractions. No helper libraries, no shared utility packages, no indirection layers unless proven necessary by duplication across three or more servers.

## Technology Stack

- **Runtime**: Node.js >= 20, TypeScript (ES2022, Node16 module resolution, ESM only)
- **Package Manager**: pnpm exclusively — never npm or yarn
- **MCP SDK**: `@modelcontextprotocol/server`, `/client`, `/node`, `/core` (v2 split packages)
- **Schemas**: Zod v4 (`import * as z from 'zod/v4'`)
- **Testing**: Vitest with `InMemoryTransport` for in-process tests
- **Deployment**: Azure Container Apps (stateful, primary) or Azure Functions Flex Consumption (stateless)
- **Enterprise**: Agent 365 tooling, observability, and notifications packages when targeting M365 governance

## Development Workflow

1. **Plan** — Identify the API, read the docs, define the tool list
2. **Scaffold** — Use the `/new-mcp-server` prompt or create manually per the dev checklist
3. **Build** — Implement tools one at a time, each with tests, referencing API docs for every endpoint
4. **Verify** — `pnpm build` must be clean, `pnpm test` must pass, all tools must be documented in README
5. **Deploy** — Add HTTP transport entry point, configure OAuth, deploy to Azure

## Governance

- This constitution is the **highest-authority document** in the workspace. It supersedes ad-hoc decisions.
- The dev checklist (`.github/SERVER-DEV-CHECKLIST.md`) operationalizes these principles — follow it for every new server.
- TypeScript conventions (`.github/instructions/typescript-server.instructions.md`) and config conventions (`.github/instructions/config-files.instructions.md`) are binding.
- Amendments require updating this document, the dev checklist, and any affected instruction files together.

**Version**: 1.0.0 | **Ratified**: 2026-02-24 | **Last Amended**: 2026-02-24
