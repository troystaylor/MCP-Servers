# ServiceNow MCP Server

## Overview

The ServiceNow MCP Server is a Model Context Protocol (MCP) server that enables AI agents to interact with ServiceNow instances. It provides 42 tools covering IT Service Management, Customer Service Management, Change Management, Knowledge Management, CMDB, Service Catalog, and Flow Designer operations.

## Capabilities

### IT Service Management (ITSM)
- **Incidents**: Create and resolve incidents
- **Problems**: Create, retrieve, update problems; link related incidents
- **Service Requests**: List requests and request items with filters

### Table API (CRUD)
- **list_records** — Query any ServiceNow table with filters, pagination, field selection
- **get_record** — Retrieve a single record by sys_id
- **create_record** — Create new records on any table
- **update_record** — Patch existing records
- **delete_record** — Remove records by sys_id

### Aggregate API
- **aggregate_records** — Compute statistics (COUNT, SUM, AVG, MIN, MAX) with grouping

### Change Management
- **create_change_request** — Create normal, standard, or emergency changes
- **get_change_request** — Retrieve change details
- **update_change_request** — Update change fields
- **check_change_conflict** — Run conflict detection
- **list_change_tasks** — List tasks associated with a change

### Knowledge Management
- **search_knowledge_articles** — Full-text search across knowledge bases
- **get_knowledge_article** — Retrieve a specific article

### Customer Service Management (CSM)
- **Cases**: Create, get, update CSM cases
- **Accounts**: List and get customer accounts
- **Contacts**: List and get customer contacts
- **Orders**: Create and get customer orders

### CMDB
- **get_cmdb_meta** — Retrieve CI class metadata and attributes
- **cmdb_identify_reconcile** — Identify and reconcile CI items

### Service Catalog
- **list_catalog_items** — Search available catalog items
- **get_catalog_item** — Get item details and variables
- **order_catalog_item** — Submit a catalog item order

### Attachments
- **list_attachments** — Query attachments on a record
- **get_attachment** — Download attachment metadata
- **delete_attachment** — Remove an attachment
- **upload_attachment** — Upload a Base64-encoded file

### Import Sets
- **import_set_insert** — Insert records into a staging table for import

### Flow Designer
- **execute_flow** — Trigger a Flow Designer flow with input variables

### Batch API
- **batch_api** — Execute multiple REST API calls in a single request

## Authentication

The server uses **OAuth 2.0 Dynamic Client Registration** for MCP-spec compliant authorization. Clients authenticate via the MCP OAuth flow:

1. Client discovers the authorization server metadata at `/.well-known/oauth-authorization-server`
2. Client registers dynamically via the DCR endpoint
3. Client obtains tokens via the authorization code grant with PKCE
4. Bearer tokens are validated on each request

The server itself authenticates to ServiceNow using OAuth 2.0 Password Grant with credentials provided via environment variables.

## Setup Requirements

1. A ServiceNow instance (developer or production)
2. An OAuth application registered in the ServiceNow Application Registry
3. ServiceNow credentials: username, password, client ID, client secret
4. Node.js >= 20

## Transport

- **stdio** — For local IDE integration (VS Code, Copilot)
- **Streamable HTTP** — For remote deployment with session management

## Limitations

- The server proxies all requests through a single ServiceNow instance configured at build time
- Attachment uploads accept Base64-encoded content (not raw binary streams)
- Flow Designer execution requires the flow sys_id — discovery is not provided
- Batch API is limited to 20 sub-requests per call
- Rate limits are enforced by the upstream ServiceNow instance
- OAuth token lifecycle is managed per-session; token refresh occurs automatically
