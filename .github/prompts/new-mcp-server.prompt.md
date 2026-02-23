---
description: Scaffold a new MCP server project with TypeScript SDK boilerplate
agent: agent
tools:
  - createFile
  - editFiles
  - runInTerminal
---

# Scaffold a New MCP Server

Create a new MCP server project in this workspace using the TypeScript SDK.

## Requirements

- Ask the user for a **server name** (kebab-case, e.g. `my-api-server`) and a **short description** of what the server does.
- Ask the user for the **official API documentation URL**. Before implementing any tools, fetch and review the API docs to get current endpoint URLs, parameters, response shapes, and auth requirements. Do not rely on general knowledge for API details.
- Create a new directory at the workspace root named after the server (e.g. `my-api-server/`).

## Project Structure

Generate the following files:

### `package.json`
```json
{
  "name": "<server-name>",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "bin": {
    "<server-name>": "./build/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx --watch src/index.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/server": "latest",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.8.0"
  }
}
```

### `tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./build",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

### `src/index.ts`
```typescript
import { McpServer, StdioServerTransport } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const server = new McpServer({
  name: '<server-name>',
  version: '0.1.0',
});

// TODO: Register tools, resources, and prompts here

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
```

## After Scaffolding

1. Run `cd <server-name> && pnpm install` to install dependencies.
2. Remind the user they can add tools with `/add-tool`.
3. Show how to test: `pnpm dev` to run in watch mode with stdio transport.
4. Ask if the server will be deployed to **Microsoft Agent 365**. If yes:
   - Add enterprise packages: `@microsoft/agents-a365-tooling`, `@microsoft/agents-a365-runtime`, `@microsoft/agents-a365-observability`
   - Use `McpToolServerConfigurationService` from `@microsoft/agents-a365-tooling` to read `ToolingManifest.json`
   - Set up Entra-backed authentication via `@microsoft/agents-a365-runtime` (OBO or agentic identity)
   - Add OpenTelemetry tracing with `ObservabilityManager.configure()` from `@microsoft/agents-a365-observability`:
     - Builder pattern: `.withService(name, version)`, `.withTokenResolver(fn)`, `.withConsoleExporter(true)`
     - Wrap agent logic in `InvokeAgentScope`, tool calls in `ExecuteToolScope`, LLM calls in `InferenceScope`
     - Use `BaggageBuilder` to set `tenantId`, `agentId`, `correlationId` across spans
   - Add `.env` vars: `ENABLE_OBSERVABILITY=true`, `ENABLE_A365_OBSERVABILITY_EXPORTER=true`
   - If the server needs to react to M365 events, add `@microsoft/agents-a365-notifications` with handlers for email, Word/Excel/PowerPoint comments, and lifecycle events
   - Explain how to publish via the MCP Management Server or the Agent 365 CLI (`a365 develop`)
5. Ask if the server will be **certified for broad M365/Copilot availability**. If yes:
   - Must be a verified publisher via Microsoft Partner Center
   - Package as a Power Platform connector: OpenAPI definition, auth config, metadata, and an `intro.md` file
   - Submit under "Microsoft 365 and Copilot – Power Platform Connector" in Partner Center
   - Must pass automated validation, manual review, and responsible AI evaluation
   - See: https://learn.microsoft.com/en-us/microsoft-agent-365/mcp-certification
