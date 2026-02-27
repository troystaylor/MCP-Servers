# MCP Certification Checklist — ServiceNow MCP Server

Status tracker for Microsoft MCP certification requirements.

## Publisher Eligibility

- [ ] Microsoft Partner Center account with verified publisher
- [ ] Business verification completed
- [ ] Enrolled in M365 and Copilot program

## Authentication

- [x] OAuth 2.0 authorization code grant with PKCE
- [x] Dynamic Client Registration (DCR) endpoint
- [x] RFC 8414 authorization server metadata
- [x] RFC 9728 protected resource metadata
- [x] Bearer token validation on all MCP endpoints
- [x] Rate limiting on auth endpoints (30/min auth, 10/min sign-in)

## Observability (Agent 365)

- [x] `InvokeAgentScope` — per-session tracing
- [x] `ExecuteToolScope` — per-tool-call tracing
- [ ] `InferenceScope` — N/A (server does not make LLM calls)
- [x] `BaggageBuilder` — tenantId, agentId, correlationId propagation
- [x] Token resolver for A365 observability exporter (MSAL)
- [ ] Verified telemetry emission in Azure Monitor

## Packaging (Power Platform Connector)

- [x] OpenAPI 3.1 definition (`certification/openapi.json`)
- [x] Auth configuration (`certification/apiProperties.json`)
- [x] Connector metadata (`certification/connector-metadata.json`)
- [x] Documentation (`certification/intro.md`)
- [ ] Connector icon (48×48 PNG)
- [ ] Submit via Partner Center under "Microsoft 365 and Copilot – Power Platform Connector"

## Automated Validation

- [ ] Schema correctness pass
- [ ] Metadata completeness pass
- [ ] Packaging integrity pass
- [ ] Policy compliance pass

## Manual Review

- [ ] Functionality testing
- [ ] Security review
- [ ] Compliance check
- [ ] Telemetry verification
- [ ] Responsible AI evaluation

## Responsible AI

- [ ] Safety testing — normal scenarios
- [ ] Safety testing — edge cases
- [ ] Safety testing — adversarial scenarios

## Deployment

- [x] Azure Container Apps deployment (production)
- [x] HTTPS enforced
- [ ] Multi-region deployment (if required)
- [ ] Post-certification monitoring
