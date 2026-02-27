# Entra Agent Identity Plan — ServiceNow MCP Server

## Overview

This plan enables full Agent 365 observability by setting up an Entra-backed agent identity, implementing a token resolver, and switching from console-only telemetry to the Agent 365 exporter service. This allows IT admins to monitor agent activity in the Microsoft 365 admin center and enables Defender/Purview compliance.

**Current state**: Observability SDK integrated with `InvokeAgentScope` + `ExecuteToolScope` tracing. `ENABLE_A365_OBSERVABILITY_EXPORTER=false` — telemetry goes to console only. No Entra identity configured.

**Target state**: Agent has its own Entra identity (blueprint + instance + agentic user), token resolver acquires tokens for the observability service, `ENABLE_A365_OBSERVABILITY_EXPORTER=true`.

---

## Prerequisites

| Requirement | Status |
|---|---|
| [Frontier preview program](https://adoption.microsoft.com/copilot/frontier-program/) membership | **Required** — Agent 365 is in preview |
| Microsoft Entra tenant with **Global Administrator**, **Agent ID Administrator**, or **Agent ID Developer** role | Verify |
| Azure subscription with contributor/owner access | ✅ `7debb32e-9376-443e-b70f-dbb46d7588e7` |
| Azure CLI authenticated (`az login`) | ✅ |
| Node.js ≥20, pnpm | ✅ |
| Agent 365 CLI installed | **Install** (see Step 1) |
| `@microsoft/agents-a365-observability` installed | ✅ `0.1.0-preview.113` |
| `@microsoft/agents-a365-runtime` installed | ✅ `0.1.0-preview.113` |

---

## Step 1 — Install the Agent 365 CLI

```powershell
npm install -g @microsoft/a365-cli
```

Verify:
```powershell
a365 --version
```

> The CLI orchestrates blueprint creation, identity registration, and resource provisioning.

---

## Step 2 — Create the Agent 365 Configuration

Navigate to the `ServiceNow/` directory and initialize:

```powershell
cd ServiceNow
a365 config init
```

The interactive wizard prompts for:

| Field | Value |
|---|---|
| Client App ID | *(your custom client app registration GUID)* |
| Deployment project path | `C:\Users\troytaylor\MCP Servers\ServiceNow` |
| Manager email | `troytaylor@yourtenant.com` |
| Azure subscription | Select existing: `ME-D365DemoTSCE72590039-troytaylor-1` |
| Resource group | `rg-dev` (existing) |
| App Service Plan | Select or create |
| Location | `eastus` |

This creates `a365.config.json` in the working directory.

Verify:
```powershell
a365 config display
```

---

## Step 3 — Create the Agent Blueprint

The blueprint defines the agent's identity, permissions, and infrastructure:

```powershell
a365 setup all
```

This performs:
1. **Azure infrastructure** — Creates/verifies resource group, App Service Plan, Web App with managed identity
2. **Agent blueprint registration** — Creates Entra application registrations with required API permissions
3. **API permissions** — Configures Microsoft Graph scopes, Messaging Bot API, Observability API permissions
4. **Admin consent** — Opens browser windows for consent flows (complete all)
5. **Generated config** — Saves IDs to `a365.generated.config.json`

> Setup takes ~3-5 minutes. Complete all browser consent flows when prompted.

### Verify

```powershell
# View generated config
a365 config display -g
```

**Key values to capture:**

| Field | Purpose |
|---|---|
| `agentBlueprintId` | Agent's unique identifier in Entra |
| `agentBlueprintObjectId` | Blueprint's Entra object ID |
| `agentBlueprintClientSecret` | Authentication secret (masked) |
| `managedIdentityPrincipalId` | Azure managed identity GUID |
| `resourceConsents` | Should include Observability API |

```powershell
# Verify Entra registration
# In https://entra.microsoft.com → App registrations → search for agentBlueprintId
# ✅ API permissions show green checkmarks
# ✅ Status shows "Granted for [Your Tenant]"
```

---

## Step 4 — Configure Container App Environment Variables

After blueprint creation, set the new env vars on the Azure Container App:

```powershell
az containerapp update `
  -n ca-servicenow-7tin6dfwl3shu `
  -g rg-dev `
  --set-env-vars `
    "TENANT_ID=<your-entra-tenant-id>" `
    "AGENT_BLUEPRINT_ID=<agentBlueprintId from generated config>" `
    "AGENT_BLUEPRINT_CLIENT_SECRET=secretref:agent-blueprint-client-secret"
```

Add the client secret as a Container App secret:
```powershell
az containerapp secret set `
  -n ca-servicenow-7tin6dfwl3shu `
  -g rg-dev `
  --secrets "agent-blueprint-client-secret=<actual-secret-value>"
```

---

## Step 5 — Implement the Token Resolver

Update `src/observability.ts` to add a token resolver that acquires tokens for the observability exporter.

### Option A: Using `@microsoft/agents-a365-runtime` (Recommended with Agent Hosting)

If using the Agent Hosting framework with `TurnContext`:

```typescript
import { getObservabilityAuthenticationScope } from '@microsoft/agents-a365-runtime';

// In your agent activity handler:
const token = await agentApplication.authorization.exchangeToken(context, 'agentic', {
  scopes: getObservabilityAuthenticationScope()
});
// Cache this token and return via tokenResolver
```

### Option B: Using MSAL directly (For standalone MCP servers)

Since the ServiceNow MCP server is a standalone tool server (not using `@microsoft/agents-hosting`), use MSAL to acquire tokens with the blueprint credentials:

```typescript
import { ConfidentialClientApplication } from '@azure/msal-node';

const msalClient = new ConfidentialClientApplication({
  auth: {
    clientId: process.env.AGENT_BLUEPRINT_ID!,
    clientSecret: process.env.AGENT_BLUEPRINT_CLIENT_SECRET!,
    authority: `https://login.microsoftonline.com/${process.env.TENANT_ID}`,
  },
});

async function tokenResolver(agentId?: string, tenantId?: string): Promise<string> {
  const result = await msalClient.acquireTokenByClientCredential({
    scopes: ['https://agent365.microsoft.com/.default'], // Observability API scope
  });
  if (!result?.accessToken) {
    throw new Error('Failed to acquire observability token');
  }
  return result.accessToken;
}
```

> **Note**: The exact scope for the observability API may differ. Check `getObservabilityAuthenticationScope()` output or the `resourceConsents` in `a365.generated.config.json` for the correct scope URI.

---

## Step 6 — Update `observability.ts`

Apply the token resolver to the `ObservabilityManager` configuration:

```typescript
// src/observability.ts — updated initObservability()

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

// MSAL client for token acquisition
let msalClient: ConfidentialClientApplication | undefined;

function getMsalClient(): ConfidentialClientApplication {
  if (!msalClient) {
    const blueprintId = process.env.AGENT_BLUEPRINT_ID;
    const clientSecret = process.env.AGENT_BLUEPRINT_CLIENT_SECRET;
    const tenantId = process.env.TENANT_ID;

    if (!blueprintId || !clientSecret || !tenantId) {
      throw new Error(
        'AGENT_BLUEPRINT_ID, AGENT_BLUEPRINT_CLIENT_SECRET, and TENANT_ID ' +
        'must be set for Agent 365 observability exporter',
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

async function tokenResolver(_agentId?: string, _tenantId?: string): Promise<string> {
  const client = getMsalClient();
  const result = await client.acquireTokenByClientCredential({
    scopes: ['https://agent365.microsoft.com/.default'],
  });
  if (!result?.accessToken) {
    throw new Error('Failed to acquire observability token');
  }
  return result.accessToken;
}

export function initObservability(): void {
  ObservabilityManager.configure((builder) => {
    builder.withService(SERVICE_NAME, SERVICE_VERSION);

    // Only set token resolver when A365 exporter is enabled
    if (process.env.ENABLE_A365_OBSERVABILITY_EXPORTER === 'true') {
      builder.withTokenResolver(tokenResolver);
    }
  });
  ObservabilityManager.start();
}
```

### New dependency required

```powershell
cd ServiceNow
pnpm add @azure/msal-node
```

---

## Step 7 — Enable the A365 Exporter

Once all the above is in place, flip the environment variable:

```powershell
az containerapp update `
  -n ca-servicenow-7tin6dfwl3shu `
  -g rg-dev `
  --set-env-vars "ENABLE_A365_OBSERVABILITY_EXPORTER=true"
```

---

## Step 8 — Verify Telemetry

### Local validation (console)

Before deploying, test locally with the exporter disabled to verify the token resolver doesn't break anything:

```powershell
$env:ENABLE_OBSERVABILITY = "true"
$env:ENABLE_A365_OBSERVABILITY_EXPORTER = "false"
$env:TENANT_ID = "your-tenant-id"
pnpm dev
```

Console should still emit `InvokeAgentScope` and `ExecuteToolScope` spans.

### Production validation

After deploying with `ENABLE_A365_OBSERVABILITY_EXPORTER=true`:

1. Make several MCP tool calls
2. Check container logs for errors:
   ```powershell
   az containerapp logs show `
     -n ca-servicenow-7tin6dfwl3shu `
     -g rg-dev `
     --follow
   ```
3. Verify telemetry in M365 admin center:
   - Navigate to `https://admin.cloud.microsoft/#/agents/all`
   - Select your agent → Activity
   - You should see sessions and tool calls

---

## Step 9 — Enhanced Agent Details (Optional)

For store publishing, the observability scopes require additional attributes. Update `AGENT_DETAILS` in `observability.ts`:

```typescript
const AGENT_DETAILS: AgentDetails = {
  agentId: process.env.AGENT_BLUEPRINT_ID ?? 'servicenow-mcp-server',
  agentName: 'ServiceNow MCP Server',
  agentType: 'mcp-tool-server',
  // Add after blueprint setup:
  agentAUID: process.env.AGENT_USER_ID,          // agentic user object ID
  agentBlueprintId: process.env.AGENT_BLUEPRINT_ID,
  agentUPN: process.env.AGENT_UPN,               // e.g. servicenow@tenant.onmicrosoft.com
};
```

---

## Deployment Checklist

| Step | Action | Reversible? |
|---|---|---|
| 1 | Install Agent 365 CLI | ✅ `npm uninstall -g` |
| 2 | `a365 config init` → `a365.config.json` | ✅ Delete file |
| 3 | `a365 setup all` → Blueprint + Entra registrations | ⚠️ Use `a365 cleanup` to undo |
| 4 | Set Container App env vars + secrets | ✅ Update/remove |
| 5 | Add `@azure/msal-node` dependency | ✅ `pnpm remove` |
| 6 | Update `observability.ts` with token resolver | ✅ Revert changes |
| 7 | Set `ENABLE_A365_OBSERVABILITY_EXPORTER=true` | ✅ Set back to `false` |
| 8 | Deploy new image to Container App | ✅ Roll back revision |
| 9 | Enhanced agent details (optional) | ✅ Revert code |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                   Azure Container App                        │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  ServiceNow MCP Server                                │   │
│  │                                                        │   │
│  │  ┌─────────────────┐    ┌─────────────────────────┐  │   │
│  │  │  Tool Execution  │───▶│  ExecuteToolScope        │  │   │
│  │  └─────────────────┘    └────────┬────────────────┘  │   │
│  │                                   │                    │   │
│  │  ┌─────────────────┐    ┌────────▼────────────────┐  │   │
│  │  │  MCP Session     │───▶│  InvokeAgentScope       │  │   │
│  │  └─────────────────┘    └────────┬────────────────┘  │   │
│  │                                   │                    │   │
│  │                          ┌────────▼────────────────┐  │   │
│  │                          │  ObservabilityManager    │  │   │
│  │                          │  + TokenResolver (MSAL)  │  │   │
│  │                          └────────┬────────────────┘  │   │
│  │                                   │                    │   │
│  └───────────────────────────────────┼────────────────────┘   │
│                                      │                        │
└──────────────────────────────────────┼────────────────────────┘
                                       │
                         ┌─────────────▼─────────────┐
                         │  Microsoft Entra ID        │
                         │  (Token Acquisition)       │
                         │                            │
                         │  Blueprint App ID          │
                         │  Client Credential Flow    │
                         └─────────────┬─────────────┘
                                       │
                         ┌─────────────▼─────────────┐
                         │  Agent 365 Observability   │
                         │  Service                   │
                         │                            │
                         │  ┌───────────────────┐     │
                         │  │ M365 Admin Center │     │
                         │  │ (Agent Activity)  │     │
                         │  └───────────────────┘     │
                         │  ┌───────────────────┐     │
                         │  │ Microsoft Defender│     │
                         │  │ (Compliance)      │     │
                         │  └───────────────────┘     │
                         └───────────────────────────┘
```

---

## Rollback Plan

If the A365 exporter causes issues in production:

```powershell
# Immediate — disable exporter, console fallback resumes
az containerapp update `
  -n ca-servicenow-7tin6dfwl3shu `
  -g rg-dev `
  --set-env-vars "ENABLE_A365_OBSERVABILITY_EXPORTER=false"
```

The `initObservability()` code is safe — it only configures the token resolver when `ENABLE_A365_OBSERVABILITY_EXPORTER=true`. Setting it to `false` reverts to console-only telemetry with zero code deployment.

---

## References

- [Agent 365 Observability](https://learn.microsoft.com/microsoft-agent-365/developer/observability?tabs=nodejs)
- [Agent 365 Identity](https://learn.microsoft.com/microsoft-agent-365/developer/identity)
- [Agent 365 Development Lifecycle](https://learn.microsoft.com/microsoft-agent-365/developer/a365-dev-lifecycle)
- [Setting up Agent 365 Config](https://learn.microsoft.com/microsoft-agent-365/developer/a365-config)
- [Setup Agent Blueprint](https://learn.microsoft.com/microsoft-agent-365/developer/registration)
- [Entra Agent Identity Blueprints](https://learn.microsoft.com/entra/agent-id/identity-platform/agent-blueprint)
- [MSAL Node.js](https://learn.microsoft.com/en-us/entra/msal/node/)
