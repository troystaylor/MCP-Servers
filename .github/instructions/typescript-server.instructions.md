---
name: 'MCP Server TypeScript'
description: 'Conventions for MCP server TypeScript source files'
applyTo: '**/src/**/*.ts'
---

# MCP Server TypeScript Conventions

- Use `import * as z from 'zod/v4'` for Zod schemas (not default import, not `zod` v3).
- Use ES module syntax (`import`/`export`), never CommonJS (`require`).
- Set `"type": "module"` in package.json.
- Target ES2022 with Node16 module resolution in tsconfig.
- Use `as const` assertions on tool content type literals (e.g., `type: 'text' as const`).
- Always add `.describe()` to Zod schema fields so LLMs understand tool parameters.
- Return errors from tools using `isError: true` in the tool result, not by throwing exceptions.
- Prefer `McpServer` (high-level API) over the low-level `Server` class unless you need fine-grained control.
- For Agent 365 enterprise servers, add `@microsoft/agents-a365-tooling` for server registration and `@microsoft/agents-a365-runtime` for Entra authentication.
- Add OpenTelemetry tracing with `@microsoft/agents-a365-observability` when building servers intended for enterprise deployment.
- Design tools to be granular and auditable — each tool call is traced in Microsoft Defender when running under Agent 365 governance.
- Use `ObservabilityManager.configure()` with `.withService(name, version)` and `.withTokenResolver(fn)` to initialize tracing. Wrap agent logic in `InvokeAgentScope`, tool calls in `ExecuteToolScope`, and LLM calls in `InferenceScope`.
- Use `BaggageBuilder` to propagate `tenantId`, `agentId`, and `correlationId` across all spans — set these before starting scopes.
- For notifications, import `AgentNotificationActivity` and `NotificationType` from `@microsoft/agents-a365-notifications`. Register handlers with `onAgentNotification()`, `onAgenticEmailNotification()`, `onAgenticWordNotification()`, etc.
- Set `ENABLE_OBSERVABILITY=true` and `ENABLE_A365_OBSERVABILITY_EXPORTER=true` in `.env` for enterprise telemetry export.
