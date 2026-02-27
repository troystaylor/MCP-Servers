/**
 * Observability — Agent 365 OpenTelemetry integration
 *
 * Configures @microsoft/agents-a365-observability with InvokeAgentScope
 * (per-session) and ExecuteToolScope (per-tool-call) tracing. InferenceScope
 * is not used because this server does not make LLM calls.
 *
 * Environment variables:
 *   ENABLE_OBSERVABILITY                — 'true' to enable tracing
 *   ENABLE_A365_OBSERVABILITY_EXPORTER  — 'true' to export to Agent365 service
 *   A365_OBSERVABILITY_LOG_LEVEL        — 'info|warn|error' for SDK internals
 *   TENANT_ID                           — Azure tenant ID for telemetry
 *   AGENT_BLUEPRINT_ID                  — Entra app registration for the agent
 *   AGENT_BLUEPRINT_CLIENT_SECRET       — Client secret for the agent blueprint
 */

import { ConfidentialClientApplication } from '@azure/msal-node';
import {
  ObservabilityManager,
  BaggageBuilder,
  ExecuteToolScope,
  InvokeAgentScope,
  ExecutionType,
  type AgentDetails,
  type TenantDetails,
  type ToolCallDetails,
  type InvokeAgentDetails,
} from '@microsoft/agents-a365-observability';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const SERVICE_NAME = 'servicenow-mcp-server';
const SERVICE_VERSION = '0.1.0';

const AGENT_DETAILS: AgentDetails = {
  agentId: process.env.AGENT_BLUEPRINT_ID ?? 'servicenow-mcp-server',
  agentName: 'ServiceNow MCP Server',
  agentType: 'mcp-tool-server',
};

const TENANT_DETAILS: TenantDetails = {
  tenantId: process.env.TENANT_ID ?? 'default',
};

// ---------------------------------------------------------------------------
// MSAL token resolver — acquires tokens for Agent 365 observability exporter
// ---------------------------------------------------------------------------

let msalClient: ConfidentialClientApplication | undefined;

function getMsalClient(): ConfidentialClientApplication {
  if (!msalClient) {
    const blueprintId = process.env.AGENT_BLUEPRINT_ID;
    const clientSecret = process.env.AGENT_BLUEPRINT_CLIENT_SECRET;
    const tenantId = process.env.TENANT_ID;

    if (!blueprintId || !clientSecret || !tenantId) {
      throw new Error(
        'AGENT_BLUEPRINT_ID, AGENT_BLUEPRINT_CLIENT_SECRET, and TENANT_ID ' +
        'must be set when ENABLE_A365_OBSERVABILITY_EXPORTER=true',
      );
    }

    msalClient = new ConfidentialClientApplication({
      auth: {
        clientId: blueprintId,
        clientSecret,
        authority: `https://login.microsoftonline.com/${tenantId}`,
      },
    });
  }
  return msalClient;
}

async function tokenResolver(): Promise<string> {
  const client = getMsalClient();
  const result = await client.acquireTokenByClientCredential({
    scopes: ['https://agent365.microsoft.com/.default'],
  });
  if (!result?.accessToken) {
    throw new Error('Failed to acquire observability token');
  }
  return result.accessToken;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export function initObservability(): void {
  ObservabilityManager.configure((builder) => {
    builder.withService(SERVICE_NAME, SERVICE_VERSION);

    if (process.env.ENABLE_A365_OBSERVABILITY_EXPORTER === 'true') {
      builder.withTokenResolver(tokenResolver);
    }
  });
  ObservabilityManager.start();
}

export async function shutdownObservability(): Promise<void> {
  await ObservabilityManager.shutdown();
}

// ---------------------------------------------------------------------------
// InvokeAgentScope — wraps an entire MCP session request
// ---------------------------------------------------------------------------

export function startInvokeScope(sessionId: string): InvokeAgentScope {
  const details: InvokeAgentDetails = {
    ...AGENT_DETAILS,
    sessionId,
    request: { executionType: ExecutionType.HumanToAgent },
  };

  return InvokeAgentScope.start(details, TENANT_DETAILS);
}

// ---------------------------------------------------------------------------
// BaggageBuilder — set per-session OpenTelemetry context
// ---------------------------------------------------------------------------

export function setBaggage(sessionId: string) {
  return BaggageBuilder.setRequestContext(
    TENANT_DETAILS.tenantId,
    AGENT_DETAILS.agentId,
    sessionId,
  );
}

// ---------------------------------------------------------------------------
// ExecuteToolScope — instrument every tool handler automatically
// ---------------------------------------------------------------------------

/**
 * Wraps every `registerTool` call on a McpServer so that the handler is
 * automatically traced with ExecuteToolScope.  Call this once, right after
 * constructing the server and before registering any tools.
 */
export function instrumentServer(server: McpServer): void {
  const original = server.registerTool.bind(server);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).registerTool = (name: string, config: any, handler: any) => {
    const wrappedHandler = async (...args: unknown[]) => {
      const toolDetails: ToolCallDetails = {
        toolName: name,
        arguments: JSON.stringify(args[0]),
      };

      const scope = ExecuteToolScope.start(
        toolDetails,
        AGENT_DETAILS,
        TENANT_DETAILS,
      );

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await (handler as any)(...args);
        const text =
          result?.content?.[0]?.text ??
          JSON.stringify(result?.content).slice(0, 2048);
        scope.recordResponse(text);
        return result;
      } catch (err) {
        if (err instanceof Error) scope.recordError(err);
        throw err;
      } finally {
        scope.dispose();
      }
    };

    return original(name, config, wrappedHandler);
  };
}
