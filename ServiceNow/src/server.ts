import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import { instrumentServer } from './observability.js';

// ---------------------------------------------------------------------------
// Configuration — read from environment variables lazily for testability
// ---------------------------------------------------------------------------

function getConfig() {
  return {
    instanceUrl: 'https://dev300384.service-now.com',
    username: process.env.SERVICENOW_USERNAME ?? '',
    password: process.env.SERVICENOW_PASSWORD ?? '',
    clientId: process.env.SERVICENOW_CLIENT_ID ?? '',
    clientSecret: process.env.SERVICENOW_CLIENT_SECRET ?? '',
  };
}

let oauthAccessToken = '';
let oauthTokenExpiry = 0;

async function fetchOAuthToken(): Promise<string> {
  const config = getConfig();
  const now = Date.now();
  if (oauthAccessToken && now < oauthTokenExpiry) return oauthAccessToken;

  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    username: config.username,
    password: config.password,
  });

  const response = await fetch(`${config.instanceUrl}/oauth_token.do`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`OAuth token request failed: HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };

  oauthAccessToken = data.access_token;
  // Refresh 60 seconds before actual expiry
  oauthTokenExpiry = now + (data.expires_in - 60) * 1000;
  return oauthAccessToken;
}

async function getAuthHeader(): Promise<string> {
  const token = await fetchOAuthToken();
  return `Bearer ${token}`;
}

function requireConfig(): string | undefined {
  const config = getConfig();
  if (!config.clientId) return 'SERVICENOW_CLIENT_ID is not set';
  if (!config.clientSecret) return 'SERVICENOW_CLIENT_SECRET is not set';
  if (!config.username) return 'SERVICENOW_USERNAME is not set';
  if (!config.password) return 'SERVICENOW_PASSWORD is not set';
  return undefined;
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

interface ServiceNowResponse<T> {
  result: T;
}

interface ServiceNowError {
  error?: { message?: string; detail?: string };
  status?: string;
}

async function snowRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<{ data?: T; error?: string; status: number }> {
  const config = getConfig();
  const url = `${config.instanceUrl}${path}`;
  const authHeader = await getAuthHeader();
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: authHeader,
    ...(options.headers as Record<string, string> | undefined),
  };

  const response = await fetch(url, { ...options, headers });

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as ServiceNowError;
      if (body.error?.message) message += `: ${body.error.message}`;
      if (body.error?.detail) message += ` — ${body.error.detail}`;
    } catch {
      // ignore JSON parse errors on error responses
    }
    return { error: message, status: response.status };
  }

  // DELETE returns 204 with no body
  if (response.status === 204) {
    return { data: undefined as unknown as T, status: 204 };
  }

  const body = (await response.json()) as ServiceNowResponse<T>;
  return { data: body.result, status: response.status };
}

// ---------------------------------------------------------------------------
// Shared Zod schemas
// ---------------------------------------------------------------------------

const DisplayValueEnum = z
  .enum(['true', 'false', 'all'])
  .describe(
    'Return display values (true), actual DB values (false), or both (all). Default: false',
  );

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'servicenow',
    version: '0.1.0',
  });

  // Wrap registerTool to trace every tool call with ExecuteToolScope
  instrumentServer(server);

  // -------------------------------------------------------------------------
  // Tool: list_records
  // -------------------------------------------------------------------------

  server.registerTool(
    'list_records',
    {
      title: 'List Records',
      description:
        'Retrieve multiple records from a ServiceNow table with optional filtering, pagination, and field selection.',
      inputSchema: z.object({
        table: z.string().describe('ServiceNow table name (e.g. "incident", "change_request", "cmdb_ci")'),
        query: z
          .string()
          .optional()
          .describe(
            'Encoded query string to filter results (e.g. "active=true^priority=1"). ' +
            'Supports operators: =, !=, ^(AND), ^OR, LIKE, STARTSWITH, ENDSWITH, ORDERBY, ORDERBYDESC',
          ),
        fields: z
          .string()
          .optional()
          .describe('Comma-separated list of fields to return (e.g. "number,short_description,state")'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .optional()
          .describe('Maximum number of records to return (1-10000). Default: 10'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Starting record index for pagination. Default: 0'),
        display_value: DisplayValueEnum.optional(),
      }),
    },
    async ({ table, query, fields, limit, offset, display_value }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const params = new URLSearchParams();
      if (query) params.set('sysparm_query', query);
      if (fields) params.set('sysparm_fields', fields);
      params.set('sysparm_limit', String(limit ?? 10));
      if (offset !== undefined) params.set('sysparm_offset', String(offset));
      if (display_value) params.set('sysparm_display_value', display_value);
      params.set('sysparm_exclude_reference_link', 'true');

      const qs = params.toString();
      const { data, error } = await snowRequest<Record<string, unknown>[]>(
        `/api/now/table/${encodeURIComponent(table)}?${qs}`,
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: get_record
  // -------------------------------------------------------------------------

  server.registerTool(
    'get_record',
    {
      title: 'Get Record',
      description:
        'Retrieve a single record by sys_id from a ServiceNow table.',
      inputSchema: z.object({
        table: z.string().describe('ServiceNow table name (e.g. "incident")'),
        sys_id: z.string().describe('The sys_id of the record to retrieve'),
        fields: z
          .string()
          .optional()
          .describe('Comma-separated list of fields to return'),
        display_value: DisplayValueEnum.optional(),
      }),
    },
    async ({ table, sys_id, fields, display_value }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const params = new URLSearchParams();
      if (fields) params.set('sysparm_fields', fields);
      if (display_value) params.set('sysparm_display_value', display_value);
      params.set('sysparm_exclude_reference_link', 'true');

      const qs = params.toString();
      const { data, error } = await snowRequest<Record<string, unknown>>(
        `/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(sys_id)}?${qs}`,
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: create_record
  // -------------------------------------------------------------------------

  server.registerTool(
    'create_record',
    {
      title: 'Create Record',
      description:
        'Insert a new record into a ServiceNow table. Returns the created record.',
      inputSchema: z.object({
        table: z.string().describe('ServiceNow table name (e.g. "incident")'),
        data: z
          .record(z.string(), z.unknown())
          .describe(
            'Field name-value pairs for the new record (e.g. {"short_description": "Server down", "urgency": "1"})',
          ),
        fields: z
          .string()
          .optional()
          .describe('Comma-separated list of fields to return in the response'),
        display_value: DisplayValueEnum.optional(),
      }),
    },
    async ({ table, data, fields, display_value }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const params = new URLSearchParams();
      if (fields) params.set('sysparm_fields', fields);
      if (display_value) params.set('sysparm_display_value', display_value);
      params.set('sysparm_exclude_reference_link', 'true');

      const qs = params.toString();
      const { data: result, error } = await snowRequest<Record<string, unknown>>(
        `/api/now/table/${encodeURIComponent(table)}?${qs}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        },
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: update_record
  // -------------------------------------------------------------------------

  server.registerTool(
    'update_record',
    {
      title: 'Update Record',
      description:
        'Update an existing record in a ServiceNow table (PATCH — only the supplied fields are modified). Returns the updated record.',
      inputSchema: z.object({
        table: z.string().describe('ServiceNow table name (e.g. "incident")'),
        sys_id: z.string().describe('The sys_id of the record to update'),
        data: z
          .record(z.string(), z.unknown())
          .describe(
            'Field name-value pairs to update (e.g. {"state": "2", "assigned_to": "admin"})',
          ),
        fields: z
          .string()
          .optional()
          .describe('Comma-separated list of fields to return in the response'),
        display_value: DisplayValueEnum.optional(),
      }),
    },
    async ({ table, sys_id, data, fields, display_value }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const params = new URLSearchParams();
      if (fields) params.set('sysparm_fields', fields);
      if (display_value) params.set('sysparm_display_value', display_value);
      params.set('sysparm_exclude_reference_link', 'true');

      const qs = params.toString();
      const { data: result, error } = await snowRequest<Record<string, unknown>>(
        `/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(sys_id)}?${qs}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        },
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: delete_record
  // -------------------------------------------------------------------------

  server.registerTool(
    'delete_record',
    {
      title: 'Delete Record',
      description:
        'Delete a record from a ServiceNow table by sys_id. Returns confirmation on success.',
      inputSchema: z.object({
        table: z.string().describe('ServiceNow table name (e.g. "incident")'),
        sys_id: z.string().describe('The sys_id of the record to delete'),
      }),
    },
    async ({ table, sys_id }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const { error } = await snowRequest<void>(
        `/api/now/table/${encodeURIComponent(table)}/${encodeURIComponent(sys_id)}`,
        { method: 'DELETE' },
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [
          {
            type: 'text' as const,
            text: `Record ${sys_id} deleted from ${table}.`,
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: aggregate_records
  // -------------------------------------------------------------------------

  server.registerTool(
    'aggregate_records',
    {
      title: 'Aggregate Records',
      description:
        'Compute aggregate statistics (count, avg, min, max, sum) on a ServiceNow table. ' +
        'Useful for dashboards and reporting without fetching every record.',
      inputSchema: z.object({
        table: z.string().describe('ServiceNow table name (e.g. "incident")'),
        query: z
          .string()
          .optional()
          .describe('Encoded query string to filter records before aggregation (e.g. "active=true")'),
        count: z
          .boolean()
          .optional()
          .describe('If true, include a count of matching records. Default: true'),
        avg_fields: z
          .string()
          .optional()
          .describe('Comma-separated fields to compute average values (e.g. "reassignment_count,priority")'),
        sum_fields: z
          .string()
          .optional()
          .describe('Comma-separated fields to compute sum values'),
        min_fields: z
          .string()
          .optional()
          .describe('Comma-separated fields to compute minimum values'),
        max_fields: z
          .string()
          .optional()
          .describe('Comma-separated fields to compute maximum values'),
        group_by: z
          .string()
          .optional()
          .describe('Comma-separated fields to group results by (e.g. "priority,state")'),
        having: z
          .string()
          .optional()
          .describe(
            'Filter groups by aggregate value. Syntax: aggregate^field^operator^value ' +
            '(e.g. "count^priority^>^3"). Separate multiple with commas.',
          ),
        order_by: z
          .string()
          .optional()
          .describe(
            'Order grouped results (e.g. "AVG^state" or "COUNT^DESC"). Groups default to ascending.',
          ),
        display_value: DisplayValueEnum.optional(),
      }),
    },
    async ({ table, query, count, avg_fields, sum_fields, min_fields, max_fields, group_by, having, order_by, display_value }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const params = new URLSearchParams();
      if (query) params.set('sysparm_query', query);
      params.set('sysparm_count', String(count ?? true));
      if (avg_fields) params.set('sysparm_avg_fields', avg_fields);
      if (sum_fields) params.set('sysparm_sum_fields', sum_fields);
      if (min_fields) params.set('sysparm_min_fields', min_fields);
      if (max_fields) params.set('sysparm_max_fields', max_fields);
      if (group_by) params.set('sysparm_group_by', group_by);
      if (having) params.set('sysparm_having', having);
      if (order_by) params.set('sysparm_order_by', order_by);
      if (display_value) params.set('sysparm_display_value', display_value);

      const qs = params.toString();
      const { data, error } = await snowRequest<unknown>(
        `/api/now/stats/${encodeURIComponent(table)}?${qs}`,
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: list_attachments
  // -------------------------------------------------------------------------

  server.registerTool(
    'list_attachments',
    {
      title: 'List Attachments',
      description:
        'List attachment metadata for a specific record or matching a query. ' +
        'Returns file names, sizes, content types, and download links — not the binary content.',
      inputSchema: z.object({
        table_name: z
          .string()
          .optional()
          .describe('Filter attachments by table name (e.g. "incident")'),
        table_sys_id: z
          .string()
          .optional()
          .describe('Filter attachments by the sys_id of the record they are attached to'),
        query: z
          .string()
          .optional()
          .describe(
            'Encoded query against the sys_attachment table (e.g. "file_name=screenshot.png"). ' +
            'Supports ORDERBY/ORDERBYDESC.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .optional()
          .describe('Maximum number of results. Default: 100'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Starting record index for pagination. Default: 0'),
      }),
    },
    async ({ table_name, table_sys_id, query, limit, offset }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const params = new URLSearchParams();
      const queryParts: string[] = [];
      if (table_name) queryParts.push(`table_name=${table_name}`);
      if (table_sys_id) queryParts.push(`table_sys_id=${table_sys_id}`);
      if (query) queryParts.push(query);
      if (queryParts.length > 0) params.set('sysparm_query', queryParts.join('^'));

      params.set('sysparm_limit', String(limit ?? 100));
      if (offset !== undefined) params.set('sysparm_offset', String(offset));

      const qs = params.toString();
      const { data, error } = await snowRequest<Record<string, unknown>[]>(
        `/api/now/attachment?${qs}`,
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: get_attachment
  // -------------------------------------------------------------------------

  server.registerTool(
    'get_attachment',
    {
      title: 'Get Attachment Metadata',
      description:
        'Retrieve metadata for a single attachment by sys_id (file name, size, content type, download link).',
      inputSchema: z.object({
        sys_id: z.string().describe('The sys_id of the attachment record'),
      }),
    },
    async ({ sys_id }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const { data, error } = await snowRequest<Record<string, unknown>>(
        `/api/now/attachment/${encodeURIComponent(sys_id)}`,
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: delete_attachment
  // -------------------------------------------------------------------------

  server.registerTool(
    'delete_attachment',
    {
      title: 'Delete Attachment',
      description: 'Delete an attachment by sys_id.',
      inputSchema: z.object({
        sys_id: z.string().describe('The sys_id of the attachment to delete'),
      }),
    },
    async ({ sys_id }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const { error } = await snowRequest<void>(
        `/api/now/attachment/${encodeURIComponent(sys_id)}`,
        { method: 'DELETE' },
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: `Attachment ${sys_id} deleted.` }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: upload_attachment
  // -------------------------------------------------------------------------

  server.registerTool(
    'upload_attachment',
    {
      title: 'Upload Attachment',
      description:
        'Upload a file attachment to a ServiceNow record. The file content should be ' +
        'provided as base64-encoded data.',
      inputSchema: z.object({
        table_name: z
          .string()
          .describe('Target table name (e.g. "incident", "change_request")'),
        table_sys_id: z
          .string()
          .describe('sys_id of the record to attach the file to'),
        file_name: z
          .string()
          .describe('Name of the file including extension (e.g. "screenshot.png")'),
        content_type: z
          .string()
          .describe('MIME type of the file (e.g. "image/png", "application/pdf", "text/plain")'),
        content_base64: z
          .string()
          .describe('Base64-encoded file content'),
      }),
    },
    async ({ table_name, table_sys_id, file_name, content_type, content_base64 }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const config = getConfig();
      const authHeader = await getAuthHeader();

      // Decode base64 to binary
      const binaryContent = Buffer.from(content_base64, 'base64');

      const url =
        `${config.instanceUrl}/api/now/attachment/file` +
        `?table_name=${encodeURIComponent(table_name)}` +
        `&table_sys_id=${encodeURIComponent(table_sys_id)}` +
        `&file_name=${encodeURIComponent(file_name)}`;

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: authHeader,
            'Content-Type': content_type,
            Accept: 'application/json',
          },
          body: binaryContent,
        });

        if (!response.ok) {
          const errText = await response.text();
          return {
            content: [{ type: 'text' as const, text: `HTTP ${response.status}: ${errText}` }],
            isError: true,
          };
        }

        const data = (await response.json()) as { result: Record<string, unknown> };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(data.result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Network error: ${String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // Tool: list_catalog_items
  // -------------------------------------------------------------------------

  server.registerTool(
    'list_catalog_items',
    {
      title: 'List Catalog Items',
      description:
        'Search and browse items in the ServiceNow Service Catalog. ' +
        'Returns catalog items available for ordering.',
      inputSchema: z.object({
        search: z
          .string()
          .optional()
          .describe('Keyword search across catalog item titles (e.g. "laptop", "VPN access")'),
        catalog_sys_id: z
          .string()
          .optional()
          .describe('Filter items by catalog sys_id'),
        category_sys_id: z
          .string()
          .optional()
          .describe('Filter items by category sys_id'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Maximum number of items to return. Default: 20'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Starting record index for pagination. Default: 0'),
      }),
    },
    async ({ search, catalog_sys_id, category_sys_id, limit, offset }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const params = new URLSearchParams();
      if (search) params.set('sysparm_text', search);
      if (catalog_sys_id) params.set('sysparm_catalog', catalog_sys_id);
      if (category_sys_id) params.set('sysparm_category', category_sys_id);
      params.set('sysparm_limit', String(limit ?? 20));
      if (offset !== undefined) params.set('sysparm_offset', String(offset));

      const qs = params.toString();
      const { data, error } = await snowRequest<unknown>(
        `/api/sn_sc/servicecatalog/items?${qs}`,
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: get_catalog_item
  // -------------------------------------------------------------------------

  server.registerTool(
    'get_catalog_item',
    {
      title: 'Get Catalog Item',
      description:
        'Retrieve full details for a Service Catalog item including its variables (form fields), ' +
        'pricing, and category information.',
      inputSchema: z.object({
        sys_id: z.string().describe('The sys_id of the catalog item'),
      }),
    },
    async ({ sys_id }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const { data, error } = await snowRequest<unknown>(
        `/api/sn_sc/servicecatalog/items/${encodeURIComponent(sys_id)}`,
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: order_catalog_item
  // -------------------------------------------------------------------------

  server.registerTool(
    'order_catalog_item',
    {
      title: 'Order Catalog Item',
      description:
        'Order a Service Catalog item by sys_id. Returns the request number and sys_id. ' +
        'Use get_catalog_item first to discover required variables.',
      inputSchema: z.object({
        sys_id: z.string().describe('The sys_id of the catalog item to order'),
        quantity: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Number of items to order. Default: 1'),
        variables: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'Variable name-value pairs for the catalog item form ' +
            '(e.g. {"urgency": "2", "comments": "Need ASAP"})',
          ),
        requested_for: z
          .string()
          .optional()
          .describe('sys_id of the user the item is being requested for (defaults to the authenticated user)'),
      }),
    },
    async ({ sys_id, quantity, variables, requested_for }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const body: Record<string, unknown> = {};
      if (quantity !== undefined) body.sysparm_quantity = String(quantity);
      if (variables) body.variables = variables;
      if (requested_for) body.sysparm_requested_for = requested_for;

      const { data, error } = await snowRequest<Record<string, unknown>>(
        `/api/sn_sc/servicecatalog/items/${encodeURIComponent(sys_id)}/order_now`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: import_set_insert
  // -------------------------------------------------------------------------

  server.registerTool(
    'import_set_insert',
    {
      title: 'Import Set Insert',
      description:
        'Insert a record into a ServiceNow Import Set staging table. ' +
        'The record will be transformed according to the configured transform map. ' +
        'Returns the staging row and transform result.',
      inputSchema: z.object({
        table: z
          .string()
          .describe('Import set table name (e.g. "u_imp_users", "imp_computer")'),
        data: z
          .record(z.string(), z.unknown())
          .describe('Field name-value pairs for the staging record'),
      }),
    },
    async ({ table, data }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const { data: result, error } = await snowRequest<Record<string, unknown>>(
        `/api/now/import/${encodeURIComponent(table)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        },
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: create_change_request
  // -------------------------------------------------------------------------

  const ChangeTypeEnum = z
    .enum(['standard', 'normal', 'emergency'])
    .describe('Type of change request to create');

  server.registerTool(
    'create_change_request',
    {
      title: 'Create Change Request',
      description:
        'Create a change request via the Change Management API. Supports standard (from template), ' +
        'normal, and emergency change types with model-driven validation.',
      inputSchema: z.object({
        type: ChangeTypeEnum,
        data: z
          .record(z.string(), z.unknown())
          .describe(
            'Change request fields (e.g. {"short_description": "Deploy patch", "assignment_group": "..."})',
          ),
        standard_change_template_id: z
          .string()
          .optional()
          .describe(
            'sys_id of the standard change template. Required when type is "standard".',
          ),
      }),
    },
    async ({ type, data, standard_change_template_id }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const body: Record<string, unknown> = { ...data };
      if (type === 'standard' && standard_change_template_id) {
        body.std_change_producer_version = standard_change_template_id;
      }

      const { data: result, error } = await snowRequest<Record<string, unknown>>(
        `/api/sn_chg_rest/change/${encodeURIComponent(type)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: get_change_request
  // -------------------------------------------------------------------------

  server.registerTool(
    'get_change_request',
    {
      title: 'Get Change Request',
      description:
        'Retrieve a change request by sys_id via the Change Management API.',
      inputSchema: z.object({
        sys_id: z.string().describe('The sys_id of the change request'),
      }),
    },
    async ({ sys_id }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const { data, error } = await snowRequest<Record<string, unknown>>(
        `/api/sn_chg_rest/change/${encodeURIComponent(sys_id)}`,
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: update_change_request
  // -------------------------------------------------------------------------

  server.registerTool(
    'update_change_request',
    {
      title: 'Update Change Request',
      description:
        'Update fields on an existing change request via the Change Management API.',
      inputSchema: z.object({
        sys_id: z.string().describe('The sys_id of the change request to update'),
        data: z
          .record(z.string(), z.unknown())
          .describe('Fields to update (e.g. {"state": "2", "risk": "3"})'),
      }),
    },
    async ({ sys_id, data }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const { data: result, error } = await snowRequest<Record<string, unknown>>(
        `/api/sn_chg_rest/change/${encodeURIComponent(sys_id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        },
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: check_change_conflict
  // -------------------------------------------------------------------------

  server.registerTool(
    'check_change_conflict',
    {
      title: 'Check Change Conflict',
      description:
        'Check for scheduling conflicts on a change request. Returns conflicting changes ' +
        'that overlap with the planned start/end window.',
      inputSchema: z.object({
        sys_id: z.string().describe('The sys_id of the change request to check for conflicts'),
      }),
    },
    async ({ sys_id }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const { data, error } = await snowRequest<unknown>(
        `/api/sn_chg_rest/change/${encodeURIComponent(sys_id)}/conflict`,
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: list_change_tasks
  // -------------------------------------------------------------------------

  server.registerTool(
    'list_change_tasks',
    {
      title: 'List Change Tasks',
      description:
        'List the change tasks associated with a change request.',
      inputSchema: z.object({
        change_sys_id: z
          .string()
          .describe('The sys_id of the parent change request'),
      }),
    },
    async ({ change_sys_id }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const { data, error } = await snowRequest<Record<string, unknown>[]>(
        `/api/sn_chg_rest/change/${encodeURIComponent(change_sys_id)}/task`,
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: search_knowledge_articles
  // -------------------------------------------------------------------------

  server.registerTool(
    'search_knowledge_articles',
    {
      title: 'Search Knowledge Articles',
      description:
        'Search ServiceNow Knowledge Base articles by keyword. Returns article titles, ' +
        'snippets, and metadata for self-service and incident deflection.',
      inputSchema: z.object({
        query: z
          .string()
          .describe('Search keywords (e.g. "password reset", "VPN setup")'),
        knowledge_base: z
          .string()
          .optional()
          .describe('sys_id of a specific knowledge base to search within'),
        language: z
          .string()
          .optional()
          .describe('Language code to filter articles (e.g. "en", "fr")'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Maximum number of articles to return. Default: 10'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Starting record index for pagination. Default: 0'),
      }),
    },
    async ({ query, knowledge_base, language, limit, offset }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const params = new URLSearchParams();
      params.set('sysparm_query', query);
      if (knowledge_base) params.set('sysparm_knowledge_base', knowledge_base);
      if (language) params.set('sysparm_language', language);
      params.set('sysparm_limit', String(limit ?? 10));
      if (offset !== undefined) params.set('sysparm_offset', String(offset));

      const qs = params.toString();
      const { data, error } = await snowRequest<unknown>(
        `/api/now/knowledge/articles?${qs}`,
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: get_knowledge_article
  // -------------------------------------------------------------------------

  server.registerTool(
    'get_knowledge_article',
    {
      title: 'Get Knowledge Article',
      description:
        'Retrieve the full content of a Knowledge Base article by sys_id.',
      inputSchema: z.object({
        sys_id: z.string().describe('The sys_id of the knowledge article'),
      }),
    },
    async ({ sys_id }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const { data, error } = await snowRequest<Record<string, unknown>>(
        `/api/now/knowledge/articles/${encodeURIComponent(sys_id)}`,
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: create_csm_case
  // -------------------------------------------------------------------------

  server.registerTool(
    'create_csm_case',
    {
      title: 'Create CSM Case',
      description:
        'Create a Customer Service Management case. Requires the CSM plugin (com.sn_customerservice).',
      inputSchema: z.object({
        data: z
          .record(z.string(), z.unknown())
          .describe(
            'Case fields (e.g. {"short_description": "Issue with billing", "account": "<sys_id>", ' +
            '"contact": "<sys_id>", "priority": "2"})',
          ),
      }),
    },
    async ({ data }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const { data: result, error } = await snowRequest<Record<string, unknown>>(
        '/api/sn_customerservice/case',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        },
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: get_csm_case
  // -------------------------------------------------------------------------

  server.registerTool(
    'get_csm_case',
    {
      title: 'Get CSM Case',
      description:
        'Retrieve a Customer Service Management case by sys_id. Requires the CSM plugin.',
      inputSchema: z.object({
        sys_id: z.string().describe('The sys_id of the CSM case'),
      }),
    },
    async ({ sys_id }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const { data, error } = await snowRequest<Record<string, unknown>>(
        `/api/sn_customerservice/case/${encodeURIComponent(sys_id)}`,
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: update_csm_case
  // -------------------------------------------------------------------------

  server.registerTool(
    'update_csm_case',
    {
      title: 'Update CSM Case',
      description:
        'Update an existing CSM case. Requires the CSM plugin.',
      inputSchema: z.object({
        sys_id: z.string().describe('The sys_id of the CSM case to update'),
        data: z
          .record(z.string(), z.unknown())
          .describe('Fields to update (e.g. {"state": "2", "priority": "1"})'),
      }),
    },
    async ({ sys_id, data }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const { data: result, error } = await snowRequest<Record<string, unknown>>(
        `/api/sn_customerservice/case/${encodeURIComponent(sys_id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        },
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: list_csm_accounts
  // -------------------------------------------------------------------------

  server.registerTool(
    'list_csm_accounts',
    {
      title: 'List CSM Accounts',
      description:
        'List Customer Service Management accounts with optional filtering. Requires the CSM plugin.',
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe('Encoded query string to filter accounts (e.g. "name=Acme Corp")'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .optional()
          .describe('Maximum number of results. Default: 20'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Starting record index for pagination. Default: 0'),
      }),
    },
    async ({ query, limit, offset }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const params = new URLSearchParams();
      if (query) params.set('sysparm_query', query);
      params.set('sysparm_limit', String(limit ?? 20));
      if (offset !== undefined) params.set('sysparm_offset', String(offset));

      const qs = params.toString();
      const { data, error } = await snowRequest<Record<string, unknown>[]>(
        `/api/now/account?${qs}`,
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: get_csm_account
  // -------------------------------------------------------------------------

  server.registerTool(
    'get_csm_account',
    {
      title: 'Get CSM Account',
      description:
        'Retrieve a single CSM account by sys_id. Requires the CSM plugin.',
      inputSchema: z.object({
        sys_id: z.string().describe('The sys_id of the CSM account'),
      }),
    },
    async ({ sys_id }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const { data, error } = await snowRequest<Record<string, unknown>>(
        `/api/now/account/${encodeURIComponent(sys_id)}`,
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: list_csm_contacts
  // -------------------------------------------------------------------------

  server.registerTool(
    'list_csm_contacts',
    {
      title: 'List CSM Contacts',
      description:
        'List Customer Service Management contacts with optional filtering. Requires the CSM plugin.',
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe('Encoded query string to filter contacts (e.g. "email=jane@example.com")'),
        account_sys_id: z
          .string()
          .optional()
          .describe('Filter contacts by account sys_id'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10000)
          .optional()
          .describe('Maximum number of results. Default: 20'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Starting record index for pagination. Default: 0'),
      }),
    },
    async ({ query, account_sys_id, limit, offset }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const params = new URLSearchParams();
      const queryParts: string[] = [];
      if (account_sys_id) queryParts.push(`account=${account_sys_id}`);
      if (query) queryParts.push(query);
      if (queryParts.length > 0) params.set('sysparm_query', queryParts.join('^'));
      params.set('sysparm_limit', String(limit ?? 20));
      if (offset !== undefined) params.set('sysparm_offset', String(offset));

      const qs = params.toString();
      const { data, error } = await snowRequest<Record<string, unknown>[]>(
        `/api/now/contact?${qs}`,
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: get_csm_contact
  // -------------------------------------------------------------------------

  server.registerTool(
    'get_csm_contact',
    {
      title: 'Get CSM Contact',
      description:
        'Retrieve a single CSM contact by sys_id. Requires the CSM plugin.',
      inputSchema: z.object({
        sys_id: z.string().describe('The sys_id of the CSM contact'),
      }),
    },
    async ({ sys_id }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const { data, error } = await snowRequest<Record<string, unknown>>(
        `/api/now/contact/${encodeURIComponent(sys_id)}`,
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: create_csm_order
  // -------------------------------------------------------------------------

  server.registerTool(
    'create_csm_order',
    {
      title: 'Create CSM Order',
      description:
        'Create a Customer Service Management order. Requires the CSM plugin (Order Management).',
      inputSchema: z.object({
        data: z
          .record(z.string(), z.unknown())
          .describe(
            'Order fields (e.g. {"account": "<sys_id>", "contact": "<sys_id>", ' +
            '"short_description": "New hardware order"})',
          ),
      }),
    },
    async ({ data }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const { data: result, error } = await snowRequest<Record<string, unknown>>(
        '/api/sn_csm_order/order',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        },
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: get_csm_order
  // -------------------------------------------------------------------------

  server.registerTool(
    'get_csm_order',
    {
      title: 'Get CSM Order',
      description:
        'Retrieve a CSM order by sys_id. Requires the CSM plugin (Order Management).',
      inputSchema: z.object({
        sys_id: z.string().describe('The sys_id of the CSM order'),
      }),
    },
    async ({ sys_id }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const { data, error } = await snowRequest<Record<string, unknown>>(
        `/api/sn_csm_order/order/${encodeURIComponent(sys_id)}`,
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: batch_api
  // -------------------------------------------------------------------------

  server.registerTool(
    'batch_api',
    {
      title: 'Batch API Requests',
      description:
        'Execute multiple ServiceNow REST API requests in a single round-trip. ' +
        'Each request in the batch is executed sequentially on the server. ' +
        'Useful for reducing network overhead when performing multiple independent operations.',
      inputSchema: z.object({
        requests: z
          .array(
            z.object({
              id: z
                .string()
                .describe('Unique identifier for this request within the batch'),
              method: z
                .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
                .describe('HTTP method'),
              url: z
                .string()
                .describe(
                  'Relative API path (e.g. "/api/now/table/incident?sysparm_limit=1")',
                ),
              headers: z
                .record(z.string(), z.string())
                .optional()
                .describe('Additional headers for this request'),
              body: z
                .unknown()
                .optional()
                .describe('Request body (for POST/PUT/PATCH)'),
            }),
          )
          .min(1)
          .max(20)
          .describe('Array of requests to execute (max 20)'),
      }),
    },
    async ({ requests }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const batchBody = {
        batch_request_payload: {
          serviced_requests: requests.map((r) => ({
            id: r.id,
            method: r.method,
            url: r.url,
            headers: r.headers ? Object.entries(r.headers).map(([name, value]) => ({ name, value })) : [],
            body: r.body !== undefined ? JSON.stringify(r.body) : undefined,
          })),
        },
      };

      const { data, error } = await snowRequest<unknown>(
        '/api/now/batch',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(batchBody),
        },
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: get_cmdb_meta
  // -------------------------------------------------------------------------

  server.registerTool(
    'get_cmdb_meta',
    {
      title: 'Get CMDB Class Metadata',
      description:
        'Retrieve metadata for a CMDB CI class including its attributes, parent class, ' +
        'and relationship types. Useful for discovering the schema of a CI class before ' +
        'querying or creating CIs.',
      inputSchema: z.object({
        class_name: z
          .string()
          .describe(
            'CMDB class name (e.g. "cmdb_ci_server", "cmdb_ci_linux_server", "cmdb_ci_appl")',
          ),
      }),
    },
    async ({ class_name }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const { data, error } = await snowRequest<unknown>(
        `/api/now/cmdb/meta/${encodeURIComponent(class_name)}`,
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: cmdb_identify_reconcile
  // -------------------------------------------------------------------------

  server.registerTool(
    'cmdb_identify_reconcile',
    {
      title: 'CMDB Identify and Reconcile',
      description:
        'Insert or update a Configuration Item (CI) in the CMDB using identification and ' +
        'reconciliation rules. ServiceNow matches the input against existing CIs and either ' +
        'creates a new one or updates the matching record. Also supports adding relationships.',
      inputSchema: z.object({
        items: z
          .array(
            z.object({
              className: z
                .string()
                .describe('CMDB class name (e.g. "cmdb_ci_linux_server")'),
              values: z
                .record(z.string(), z.unknown())
                .describe(
                  'CI attribute values (e.g. {"name": "web-prod-01", "ip_address": "10.0.1.5"})',
                ),
              lookup: z
                .array(
                  z.object({
                    className: z.string().describe('Lookup rule class name'),
                    values: z
                      .record(z.string(), z.unknown())
                      .describe('Lookup matching values'),
                  }),
                )
                .optional()
                .describe('Additional lookup criteria to match existing CIs'),
            }),
          )
          .min(1)
          .max(50)
          .describe('Array of CIs to identify and reconcile (max 50)'),
        relations: z
          .array(
            z.object({
              parent: z.number().int().describe('Index of the parent item in the items array'),
              child: z.number().int().describe('Index of the child item in the items array'),
              type: z
                .string()
                .describe('Relationship type sys_id or name (e.g. "Runs on::Runs")'),
            }),
          )
          .optional()
          .describe('Relationships between CI items in this payload'),
      }),
    },
    async ({ items, relations }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const body: Record<string, unknown> = { items };
      if (relations) body.relations = relations;

      const { data, error } = await snowRequest<unknown>(
        '/api/now/cmdb/instance/identify_and_reconcile',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // =========================================================================
  // INCIDENT MANAGEMENT
  // =========================================================================

  // -------------------------------------------------------------------------
  // Tool: create_incident
  // -------------------------------------------------------------------------

  server.registerTool(
    'create_incident',
    {
      title: 'Create Incident',
      description:
        'Create a new IT incident in ServiceNow. Automatically sets caller_id if not provided ' +
        'and the authenticated user has an associated sys_user record.',
      inputSchema: z.object({
        short_description: z
          .string()
          .describe('Brief summary of the incident (required)'),
        description: z
          .string()
          .optional()
          .describe('Detailed description of the incident'),
        caller_id: z
          .string()
          .optional()
          .describe('sys_id of the user reporting the incident'),
        category: z
          .string()
          .optional()
          .describe('Incident category (e.g. "software", "hardware", "network")'),
        subcategory: z
          .string()
          .optional()
          .describe('Incident subcategory'),
        impact: z
          .enum(['1', '2', '3'])
          .optional()
          .describe('Impact: 1=High, 2=Medium, 3=Low'),
        urgency: z
          .enum(['1', '2', '3'])
          .optional()
          .describe('Urgency: 1=High, 2=Medium, 3=Low'),
        assignment_group: z
          .string()
          .optional()
          .describe('sys_id of the assignment group'),
        assigned_to: z
          .string()
          .optional()
          .describe('sys_id of the assigned user'),
        configuration_item: z
          .string()
          .optional()
          .describe('sys_id of the affected CI'),
        additional_fields: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Additional field values to set on the incident'),
      }),
    },
    async (args) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const body: Record<string, unknown> = {
        short_description: args.short_description,
        ...args.additional_fields,
      };
      if (args.description) body.description = args.description;
      if (args.caller_id) body.caller_id = args.caller_id;
      if (args.category) body.category = args.category;
      if (args.subcategory) body.subcategory = args.subcategory;
      if (args.impact) body.impact = args.impact;
      if (args.urgency) body.urgency = args.urgency;
      if (args.assignment_group) body.assignment_group = args.assignment_group;
      if (args.assigned_to) body.assigned_to = args.assigned_to;
      if (args.configuration_item) body.cmdb_ci = args.configuration_item;

      const { data, error } = await snowRequest<Record<string, unknown>>(
        '/api/now/table/incident',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: resolve_incident
  // -------------------------------------------------------------------------

  server.registerTool(
    'resolve_incident',
    {
      title: 'Resolve Incident',
      description:
        'Resolve an incident by setting its state to Resolved (6) and providing resolution details.',
      inputSchema: z.object({
        sys_id: z.string().describe('sys_id of the incident to resolve'),
        close_code: z
          .string()
          .describe(
            'Resolution code (e.g. "Solved (Work Around)", "Solved (Permanently)", "Not Solved (Not Reproducible)")',
          ),
        close_notes: z.string().describe('Resolution notes explaining how the incident was resolved'),
        resolved_by: z
          .string()
          .optional()
          .describe('sys_id of the user who resolved the incident (defaults to caller)'),
      }),
    },
    async ({ sys_id, close_code, close_notes, resolved_by }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const body: Record<string, unknown> = {
        incident_state: '6', // Resolved
        state: '6',
        close_code,
        close_notes,
      };
      if (resolved_by) body.resolved_by = resolved_by;

      const { data, error } = await snowRequest<Record<string, unknown>>(
        `/api/now/table/incident/${encodeURIComponent(sys_id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // =========================================================================
  // PROBLEM MANAGEMENT
  // =========================================================================

  // -------------------------------------------------------------------------
  // Tool: create_problem
  // -------------------------------------------------------------------------

  server.registerTool(
    'create_problem',
    {
      title: 'Create Problem',
      description:
        'Create a new Problem record. Problems are used to investigate the root cause ' +
        'of one or more incidents.',
      inputSchema: z.object({
        short_description: z.string().describe('Brief summary of the problem'),
        description: z.string().optional().describe('Detailed problem description'),
        impact: z
          .enum(['1', '2', '3'])
          .optional()
          .describe('Impact: 1=High, 2=Medium, 3=Low'),
        urgency: z
          .enum(['1', '2', '3'])
          .optional()
          .describe('Urgency: 1=High, 2=Medium, 3=Low'),
        assignment_group: z
          .string()
          .optional()
          .describe('sys_id of the assignment group'),
        assigned_to: z.string().optional().describe('sys_id of the assigned user'),
        category: z.string().optional().describe('Problem category'),
        configuration_item: z
          .string()
          .optional()
          .describe('sys_id of the affected CI'),
        related_incidents: z
          .array(z.string())
          .optional()
          .describe('Array of incident sys_ids to associate with this problem'),
        additional_fields: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Additional field values'),
      }),
    },
    async (args) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const body: Record<string, unknown> = {
        short_description: args.short_description,
        ...args.additional_fields,
      };
      if (args.description) body.description = args.description;
      if (args.impact) body.impact = args.impact;
      if (args.urgency) body.urgency = args.urgency;
      if (args.assignment_group) body.assignment_group = args.assignment_group;
      if (args.assigned_to) body.assigned_to = args.assigned_to;
      if (args.category) body.category = args.category;
      if (args.configuration_item) body.cmdb_ci = args.configuration_item;

      const { data, error } = await snowRequest<Record<string, unknown>>(
        '/api/now/table/problem',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      // Optionally link related incidents
      const result = data as Record<string, unknown>;
      if (args.related_incidents && args.related_incidents.length > 0 && result.sys_id) {
        for (const incidentId of args.related_incidents) {
          await snowRequest<unknown>(
            `/api/now/table/incident/${encodeURIComponent(incidentId)}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ problem_id: result.sys_id }),
            },
          );
        }
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: get_problem
  // -------------------------------------------------------------------------

  server.registerTool(
    'get_problem',
    {
      title: 'Get Problem',
      description:
        'Retrieve a Problem record by sys_id or problem number.',
      inputSchema: z.object({
        sys_id: z
          .string()
          .optional()
          .describe('sys_id of the problem record'),
        number: z
          .string()
          .optional()
          .describe('Problem number (e.g. "PRB0040001")'),
        fields: z
          .string()
          .optional()
          .describe('Comma-separated list of fields to return'),
        display_value: DisplayValueEnum.optional(),
      }),
    },
    async ({ sys_id, number, fields, display_value }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      if (!sys_id && !number) {
        return {
          content: [{ type: 'text' as const, text: 'Either sys_id or number is required' }],
          isError: true,
        };
      }

      const params = new URLSearchParams();
      if (fields) params.set('sysparm_fields', fields);
      if (display_value) params.set('sysparm_display_value', display_value);
      params.set('sysparm_exclude_reference_link', 'true');

      let path: string;
      if (sys_id) {
        path = `/api/now/table/problem/${encodeURIComponent(sys_id)}?${params.toString()}`;
      } else {
        params.set('sysparm_query', `number=${number}`);
        params.set('sysparm_limit', '1');
        path = `/api/now/table/problem?${params.toString()}`;
      }

      const { data, error } = await snowRequest<
        Record<string, unknown> | Record<string, unknown>[]
      >(path);

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      const result = Array.isArray(data) ? data[0] : data;
      if (!result) {
        return {
          content: [{ type: 'text' as const, text: 'Problem not found' }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: update_problem
  // -------------------------------------------------------------------------

  server.registerTool(
    'update_problem',
    {
      title: 'Update Problem',
      description:
        'Update an existing Problem record. Can update state, root cause, workaround, ' +
        'assignment, and other fields.',
      inputSchema: z.object({
        sys_id: z.string().describe('sys_id of the problem to update'),
        state: z
          .enum(['1', '2', '3', '4', '5', '6', '7'])
          .optional()
          .describe(
            'Problem state: 1=New, 2=Assess, 3=Root Cause Analysis, ' +
            '4=Fix in Progress, 5=Resolved, 6=Closed, 7=Canceled',
          ),
        cause_notes: z.string().optional().describe('Root cause analysis notes'),
        fix_notes: z.string().optional().describe('Fix/resolution notes'),
        workaround: z.string().optional().describe('Workaround description'),
        known_error: z
          .boolean()
          .optional()
          .describe('Mark as known error (true/false)'),
        assignment_group: z.string().optional().describe('sys_id of the assignment group'),
        assigned_to: z.string().optional().describe('sys_id of the assigned user'),
        additional_fields: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Additional field values to update'),
      }),
    },
    async (args) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const body: Record<string, unknown> = { ...args.additional_fields };
      if (args.state) body.state = args.state;
      if (args.cause_notes) body.cause_notes = args.cause_notes;
      if (args.fix_notes) body.fix_notes = args.fix_notes;
      if (args.workaround) body.workaround = args.workaround;
      if (args.known_error !== undefined) body.known_error = args.known_error;
      if (args.assignment_group) body.assignment_group = args.assignment_group;
      if (args.assigned_to) body.assigned_to = args.assigned_to;

      const { data, error } = await snowRequest<Record<string, unknown>>(
        `/api/now/table/problem/${encodeURIComponent(args.sys_id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // =========================================================================
  // SERVICE REQUEST MANAGEMENT
  // =========================================================================

  // -------------------------------------------------------------------------
  // Tool: list_requests
  // -------------------------------------------------------------------------

  server.registerTool(
    'list_requests',
    {
      title: 'List Service Requests',
      description:
        'List Service Requests (sc_request) with optional filtering. Service Requests ' +
        'are created when users order items from the Service Catalog.',
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe('Encoded query string (e.g. "request_state=approved^opened_by=<user_sys_id>")'),
        requested_for: z
          .string()
          .optional()
          .describe('Filter by sys_id of the user the request is for'),
        request_state: z
          .enum(['pending', 'approved', 'rejected', 'closed_complete', 'closed_incomplete', 'closed_cancelled'])
          .optional()
          .describe('Filter by request state'),
        limit: z.number().int().min(1).max(100).optional().describe('Max records to return (default: 20)'),
        offset: z.number().int().min(0).optional().describe('Pagination offset'),
        fields: z.string().optional().describe('Comma-separated fields to return'),
        display_value: DisplayValueEnum.optional(),
      }),
    },
    async ({ query, requested_for, request_state, limit, offset, fields, display_value }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const params = new URLSearchParams();
      const queryParts: string[] = [];
      if (query) queryParts.push(query);
      if (requested_for) queryParts.push(`requested_for=${requested_for}`);
      if (request_state) queryParts.push(`request_state=${request_state}`);
      if (queryParts.length > 0) params.set('sysparm_query', queryParts.join('^'));
      if (fields) params.set('sysparm_fields', fields);
      params.set('sysparm_limit', String(limit ?? 20));
      if (offset !== undefined) params.set('sysparm_offset', String(offset));
      if (display_value) params.set('sysparm_display_value', display_value);
      params.set('sysparm_exclude_reference_link', 'true');

      const { data, error } = await snowRequest<Record<string, unknown>[]>(
        `/api/now/table/sc_request?${params.toString()}`,
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: get_request_item
  // -------------------------------------------------------------------------

  server.registerTool(
    'get_request_item',
    {
      title: 'Get Request Item',
      description:
        'Retrieve a Requested Item (sc_req_item) by sys_id. Request Items represent ' +
        'individual catalog items that have been ordered within a Service Request.',
      inputSchema: z.object({
        sys_id: z.string().describe('sys_id of the requested item'),
        fields: z.string().optional().describe('Comma-separated fields to return'),
        display_value: DisplayValueEnum.optional(),
      }),
    },
    async ({ sys_id, fields, display_value }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const params = new URLSearchParams();
      if (fields) params.set('sysparm_fields', fields);
      if (display_value) params.set('sysparm_display_value', display_value);
      params.set('sysparm_exclude_reference_link', 'true');

      const { data, error } = await snowRequest<Record<string, unknown>>(
        `/api/now/table/sc_req_item/${encodeURIComponent(sys_id)}?${params.toString()}`,
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: list_request_items
  // -------------------------------------------------------------------------

  server.registerTool(
    'list_request_items',
    {
      title: 'List Request Items',
      description:
        'List Requested Items (sc_req_item) with optional filtering. Can filter by ' +
        'parent request, catalog item, stage, or custom query.',
      inputSchema: z.object({
        request: z
          .string()
          .optional()
          .describe('Filter by parent request sys_id'),
        cat_item: z
          .string()
          .optional()
          .describe('Filter by catalog item sys_id'),
        stage: z
          .enum(['waiting_for_approval', 'request_approved', 'fulfillment', 'delivery', 'completed', 'cancelled'])
          .optional()
          .describe('Filter by fulfillment stage'),
        query: z.string().optional().describe('Additional encoded query string'),
        limit: z.number().int().min(1).max(100).optional().describe('Max records (default: 20)'),
        offset: z.number().int().min(0).optional().describe('Pagination offset'),
        fields: z.string().optional().describe('Comma-separated fields to return'),
        display_value: DisplayValueEnum.optional(),
      }),
    },
    async ({ request, cat_item, stage, query, limit, offset, fields, display_value }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const params = new URLSearchParams();
      const queryParts: string[] = [];
      if (request) queryParts.push(`request=${request}`);
      if (cat_item) queryParts.push(`cat_item=${cat_item}`);
      if (stage) queryParts.push(`stage=${stage}`);
      if (query) queryParts.push(query);
      if (queryParts.length > 0) params.set('sysparm_query', queryParts.join('^'));
      if (fields) params.set('sysparm_fields', fields);
      params.set('sysparm_limit', String(limit ?? 20));
      if (offset !== undefined) params.set('sysparm_offset', String(offset));
      if (display_value) params.set('sysparm_display_value', display_value);
      params.set('sysparm_exclude_reference_link', 'true');

      const { data, error } = await snowRequest<Record<string, unknown>[]>(
        `/api/now/table/sc_req_item?${params.toString()}`,
      );

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  // =========================================================================
  // FLOW DESIGNER / WORKFLOW
  // =========================================================================

  // -------------------------------------------------------------------------
  // Tool: execute_flow
  // -------------------------------------------------------------------------

  server.registerTool(
    'execute_flow',
    {
      title: 'Execute Flow',
      description:
        'Trigger a Flow Designer flow or Subflow by scope and name. Flows are low-code ' +
        'automation workflows in ServiceNow. Returns execution details and outputs.',
      inputSchema: z.object({
        scope: z
          .string()
          .describe('Application scope of the flow (e.g. "global", "x_myapp")'),
        flow_name: z
          .string()
          .describe('Internal name of the flow (not display name)'),
        inputs: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Input values for the flow as key-value pairs'),
        wait_for_completion: z
          .boolean()
          .optional()
          .describe(
            'If true, waits for flow completion and returns outputs. ' +
            'If false (default), returns immediately with execution ID.',
          ),
      }),
    },
    async ({ scope, flow_name, inputs, wait_for_completion }) => {
      const configErr = requireConfig();
      if (configErr) return { content: [{ type: 'text' as const, text: configErr }], isError: true };

      const body: Record<string, unknown> = {};
      if (inputs) body.inputs = inputs;

      // Use the Flow Designer REST API
      const path = `/api/now/flow/${encodeURIComponent(scope)}/${encodeURIComponent(flow_name)}`;

      const { data, error, status } = await snowRequest<Record<string, unknown>>(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (error) return { content: [{ type: 'text' as const, text: error }], isError: true };

      // If wait_for_completion is true and we got a context_id, poll for completion
      if (wait_for_completion && data && typeof data === 'object' && 'context_id' in data) {
        const contextId = data.context_id as string;
        const maxAttempts = 30;
        const pollInterval = 2000; // 2 seconds

        for (let i = 0; i < maxAttempts; i++) {
          await new Promise((resolve) => setTimeout(resolve, pollInterval));

          const { data: statusData, error: statusError } = await snowRequest<Record<string, unknown>>(
            `/api/now/table/sys_flow_context/${encodeURIComponent(contextId)}?sysparm_fields=state,outputs`,
          );

          if (statusError) {
            return { content: [{ type: 'text' as const, text: statusError }], isError: true };
          }

          const state = statusData?.state as string | undefined;
          if (state === 'complete' || state === 'error' || state === 'cancelled') {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(statusData, null, 2) }],
            };
          }
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `Flow did not complete within timeout. Context ID: ${contextId}`,
            },
          ],
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
      };
    },
  );

  return server;
}
