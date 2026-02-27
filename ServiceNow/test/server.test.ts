/**
 * Unit tests for ServiceNow MCP Server
 *
 * Uses InMemoryTransport for in-process client-server communication
 * and mocks fetch to simulate ServiceNow API responses.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

// Set required environment variables before importing server
process.env.SERVICENOW_USERNAME = 'test_user';
process.env.SERVICENOW_PASSWORD = 'test_password';
process.env.SERVICENOW_CLIENT_ID = 'test_client_id';
process.env.SERVICENOW_CLIENT_SECRET = 'test_client_secret';

// Import server factory after env vars are set
import { createServer } from '../src/server.js';

// Mock fetch globally — wraps an inner mock so OAuth token requests are
// handled automatically while per-test API mocks work as before.
const apiMock = vi.fn();
const mockFetch = vi.fn().mockImplementation(
  (url: string, options?: RequestInit) => {
    // Intercept OAuth token requests transparently
    if (typeof url === 'string' && url.endsWith('/oauth_token.do')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'mock_oauth_token', expires_in: 86400 }),
      });
    }
    // Delegate everything else to the per-test mock
    return apiMock(url, options);
  },
);
vi.stubGlobal('fetch', mockFetch);

describe('ServiceNow MCP Server', () => {
  let client: Client;
  let serverTransport: InMemoryTransport;
  let clientTransport: InMemoryTransport;

  beforeEach(async () => {
    // Reset per-test API mock (OAuth mock stays in mockFetch implementation)
    apiMock.mockReset();

    // Create server and client
    const server = createServer();
    client = new Client({
      name: 'test-client',
      version: '1.0.0',
    });

    // Create linked transports
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    // Connect
    await Promise.all([
      client.connect(clientTransport),
      server.server.connect(serverTransport),
    ]);
  });

  afterEach(async () => {
    await clientTransport.close();
    await serverTransport.close();
  });

  describe('Tool Discovery', () => {
    test('should list all registered tools', async () => {
      const result = await client.listTools();

      expect(result.tools).toBeDefined();
      expect(result.tools.length).toBeGreaterThan(0);

      // Verify some key tools are registered
      const toolNames = result.tools.map((t) => t.name);
      expect(toolNames).toContain('list_records');
      expect(toolNames).toContain('get_record');
      expect(toolNames).toContain('create_record');
      expect(toolNames).toContain('update_record');
      expect(toolNames).toContain('delete_record');
      expect(toolNames).toContain('aggregate_records');
      expect(toolNames).toContain('search_knowledge_articles');
      expect(toolNames).toContain('create_change_request');
      expect(toolNames).toContain('get_cmdb_meta');
    });

    test('tools should have descriptions', async () => {
      const result = await client.listTools();

      for (const tool of result.tools) {
        expect(tool.description).toBeDefined();
        expect(tool.description!.length).toBeGreaterThan(0);
      }
    });

    test('tools should have input schemas', async () => {
      const result = await client.listTools();

      for (const tool of result.tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
      }
    });
  });

  describe('Table API Tools', () => {
    test('list_records should call the correct endpoint', async () => {
      // Mock successful response
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: [
            { sys_id: 'abc123', short_description: 'Test record' },
          ],
        }),
      });

      const result = await client.callTool({
        name: 'list_records',
        arguments: {
          table: 'incident',
          sysparm_limit: 10,
        },
      }) as ToolResult;

      // Verify fetch was called correctly
      expect(apiMock).toHaveBeenCalledTimes(1);
      const [url, options] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/now/table/incident');
      expect(url).toContain('sysparm_limit=10');
      expect(options.headers.Authorization).toMatch(/^Bearer /);

      // Verify result
      expect(result.isError).toBeUndefined();
      expect(result.content).toBeDefined();
      expect(result.content[0]!.type).toBe('text');
    });

    test('get_record should fetch a single record', async () => {
      const sysId = 'abc123def456';
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: { sys_id: sysId, short_description: 'Test incident' },
        }),
      });

      const result = await client.callTool({
        name: 'get_record',
        arguments: {
          table: 'incident',
          sys_id: sysId,
        },
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain(`/api/now/table/incident/${sysId}`);
      expect(result.isError).toBeUndefined();
    });

    test('create_record should POST to the table endpoint', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          result: { sys_id: 'new123', short_description: 'New incident' },
        }),
      });

      const result = await client.callTool({
        name: 'create_record',
        arguments: {
          table: 'incident',
          data: { short_description: 'New incident', urgency: '2' },
        },
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      const [url, options] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/now/table/incident');
      expect(options.method).toBe('POST');
      expect(options.headers['Content-Type']).toBe('application/json');
      expect(result.isError).toBeUndefined();
    });

    test('update_record should PATCH the record', async () => {
      const sysId = 'abc123';
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: { sys_id: sysId, short_description: 'Updated' },
        }),
      });

      const result = await client.callTool({
        name: 'update_record',
        arguments: {
          table: 'incident',
          sys_id: sysId,
          data: { short_description: 'Updated' },
        },
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      const [url, options] = apiMock.mock.calls[0]!;
      expect(url).toContain(`/api/now/table/incident/${sysId}`);
      expect(options.method).toBe('PATCH');
      expect(result.isError).toBeUndefined();
    });

    test('delete_record should DELETE the record', async () => {
      const sysId = 'abc123';
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 204,
        json: async () => ({}),
      });

      const result = await client.callTool({
        name: 'delete_record',
        arguments: {
          table: 'incident',
          sys_id: sysId,
        },
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      const [url, options] = apiMock.mock.calls[0]!;
      expect(url).toContain(`/api/now/table/incident/${sysId}`);
      expect(options.method).toBe('DELETE');
      expect(result.isError).toBeUndefined();
    });
  });

  describe('Error Handling', () => {
    test('should return error for HTTP failures', async () => {
      apiMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({
          error: { message: 'Record not found', detail: 'No record with sys_id' },
        }),
      });

      const result = await client.callTool({
        name: 'get_record',
        arguments: {
          table: 'incident',
          sys_id: 'nonexistent',
        },
      });

      expect(result.isError).toBe(true);
      const errorResult = result as ToolResult;
      expect(errorResult.content[0]!.type).toBe('text');
      const text = errorResult.content[0]!.text;
      expect(text).toContain('404');
    });

    test('should return error for network failures', async () => {
      apiMock.mockRejectedValueOnce(new Error('Network error'));

      const result = await client.callTool({
        name: 'list_records',
        arguments: {
          table: 'incident',
        },
      });

      expect(result.isError).toBe(true);
    });
  });

  describe('Aggregate API', () => {
    test('aggregate_records should call stats endpoint', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: {
            stats: { count: 42 },
          },
        }),
      });

      const result = await client.callTool({
        name: 'aggregate_records',
        arguments: {
          table: 'incident',
          sysparm_count: true,
        },
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/now/stats/incident');
      expect(result.isError).toBeUndefined();
    });
  });

  describe('Knowledge API', () => {
    test('search_knowledge_articles should search knowledge base', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: [
            { sys_id: 'kb001', short_description: 'How to reset password' },
          ],
        }),
      });

      const result = await client.callTool({
        name: 'search_knowledge_articles',
        arguments: {
          query: 'password reset',
        },
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/now/knowledge/articles');
      expect(url).toContain('password');
      expect(result.isError).toBeUndefined();
    });
  });

  describe('Change Management API', () => {
    test('create_change_request should POST to change API', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          result: {
            sys_id: 'chg001',
            number: 'CHG0000001',
            type: 'normal',
          },
        }),
      });

      const result = await client.callTool({
        name: 'create_change_request',
        arguments: {
          type: 'normal',
          data: {
            short_description: 'Deploy new feature',
            description: 'Deploying feature X to production',
          },
        },
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      const [url, options] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/sn_chg_rest/change/normal');
      expect(options.method).toBe('POST');
      expect(result.isError).toBeUndefined();
    });
  });

  describe('CMDB API', () => {
    test('get_cmdb_meta should fetch CI class metadata', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: {
            name: 'cmdb_ci_server',
            label: 'Server',
            attributes: [],
          },
        }),
      });

      const result = await client.callTool({
        name: 'get_cmdb_meta',
        arguments: {
          class_name: 'cmdb_ci_server',
        },
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/now/cmdb/meta/cmdb_ci_server');
      expect(result.isError).toBeUndefined();
    });

    test('cmdb_identify_reconcile should POST items for reconciliation', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: { items: [{ sysId: 'ci001', operation: 'INSERT' }] },
        }),
      });

      const result = await client.callTool({
        name: 'cmdb_identify_reconcile',
        arguments: {
          items: [
            {
              className: 'cmdb_ci_linux_server',
              values: { name: 'web-prod-01', ip_address: '10.0.1.5' },
            },
          ],
        },
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      const [url, options] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/now/cmdb/instance/identify_and_reconcile');
      expect(options.method).toBe('POST');
      expect(result.isError).toBeUndefined();
    });
  });

  describe('Attachment API', () => {
    test('list_attachments should query the attachment endpoint', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: [{ sys_id: 'att001', file_name: 'report.pdf' }],
        }),
      });

      const result = await client.callTool({
        name: 'list_attachments',
        arguments: {
          table_name: 'incident',
          table_sys_id: 'inc001',
        },
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/now/attachment');
      expect(url).toContain('table_name%3Dincident');
      expect(result.isError).toBeUndefined();
    });

    test('get_attachment should fetch a single attachment', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: { sys_id: 'att001', file_name: 'report.pdf', size_bytes: '1024' },
        }),
      });

      const result = await client.callTool({
        name: 'get_attachment',
        arguments: { sys_id: 'att001' },
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/now/attachment/att001');
      expect(result.isError).toBeUndefined();
    });

    test('delete_attachment should DELETE the attachment', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 204,
        json: async () => ({}),
      });

      const result = await client.callTool({
        name: 'delete_attachment',
        arguments: { sys_id: 'att001' },
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      const [url, options] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/now/attachment/att001');
      expect(options.method).toBe('DELETE');
      expect(result.isError).toBeUndefined();
    });

    test('upload_attachment should POST base64 content', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          result: { sys_id: 'att002', file_name: 'test.txt' },
        }),
      });

      const result = await client.callTool({
        name: 'upload_attachment',
        arguments: {
          table_name: 'incident',
          table_sys_id: 'inc001',
          file_name: 'test.txt',
          content_type: 'text/plain',
          content_base64: Buffer.from('hello').toString('base64'),
        },
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      const [url, options] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/now/attachment/file');
      expect(url).toContain('table_name=incident');
      expect(url).toContain('table_sys_id=inc001');
      expect(url).toContain('file_name=test.txt');
      expect(options.method).toBe('POST');
      expect(options.headers['Content-Type']).toBe('text/plain');
      expect(result.isError).toBeUndefined();
    });
  });

  describe('Service Catalog API', () => {
    test('list_catalog_items should search the catalog', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: [{ sys_id: 'cat001', name: 'Laptop' }],
        }),
      });

      const result = await client.callTool({
        name: 'list_catalog_items',
        arguments: { search: 'laptop', limit: 5 },
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/sn_sc/servicecatalog/items');
      expect(url).toContain('laptop');
      expect(result.isError).toBeUndefined();
    });

    test('get_catalog_item should fetch item details', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: { sys_id: 'cat001', name: 'Laptop', price: '$1500' },
        }),
      });

      const result = await client.callTool({
        name: 'get_catalog_item',
        arguments: { sys_id: 'cat001' },
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/sn_sc/servicecatalog/items/cat001');
      expect(result.isError).toBeUndefined();
    });

    test('order_catalog_item should POST an order', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: { sys_id: 'req001', number: 'REQ0000001' },
        }),
      });

      const result = await client.callTool({
        name: 'order_catalog_item',
        arguments: {
          sys_id: 'cat001',
          quantity: 2,
          variables: { urgency: '2' },
        },
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      const [url, options] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/sn_sc/servicecatalog/items/cat001/order_now');
      expect(options.method).toBe('POST');
      expect(result.isError).toBeUndefined();
    });
  });

  describe('Import Set API', () => {
    test('import_set_insert should POST to the import endpoint', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          result: { import_set: 'ISET001', staging_table: 'u_imp_users' },
        }),
      });

      const result = await client.callTool({
        name: 'import_set_insert',
        arguments: {
          table: 'u_imp_users',
          data: { u_name: 'Jane Doe', u_email: 'jane@example.com' },
        },
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      const [url, options] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/now/import/u_imp_users');
      expect(options.method).toBe('POST');
      expect(result.isError).toBeUndefined();
    });
  });

  describe('Change Management API (extended)', () => {
    test('get_change_request should GET by sys_id', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: { sys_id: 'chg001', number: 'CHG0000001', type: 'normal' },
        }),
      });

      const result = await client.callTool({
        name: 'get_change_request',
        arguments: { sys_id: 'chg001' },
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/sn_chg_rest/change/chg001');
      expect(result.isError).toBeUndefined();
    });

    test('update_change_request should PATCH the change', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: { sys_id: 'chg001', state: '2' },
        }),
      });

      const result = await client.callTool({
        name: 'update_change_request',
        arguments: {
          sys_id: 'chg001',
          data: { state: '2', risk: 'moderate' },
        },
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      const [, options] = apiMock.mock.calls[0]!;
      expect(options.method).toBe('PATCH');
      expect(result.isError).toBeUndefined();
    });

    test('check_change_conflict should POST conflict check', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: { has_conflict: false, conflicts: [] },
        }),
      });

      const result = await client.callTool({
        name: 'check_change_conflict',
        arguments: { sys_id: 'chg001' },
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/sn_chg_rest/change/chg001/conflict');
      expect(result.isError).toBeUndefined();
    });

    test('list_change_tasks should GET tasks for a change', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: [{ sys_id: 'ctask001', short_description: 'Backup DB' }],
        }),
      });

      const result = await client.callTool({
        name: 'list_change_tasks',
        arguments: { change_sys_id: 'chg001' },
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/sn_chg_rest/change/chg001/task');
      expect(result.isError).toBeUndefined();
    });
  });

  describe('Knowledge API (extended)', () => {
    test('get_knowledge_article should fetch article by sys_id', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: { sys_id: 'kb001', short_description: 'VPN Setup Guide', text: '<p>Steps...</p>' },
        }),
      });

      const result = await client.callTool({
        name: 'get_knowledge_article',
        arguments: { sys_id: 'kb001' },
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/now/knowledge/articles/kb001');
      expect(result.isError).toBeUndefined();
    });
  });

  describe('CSM API', () => {
    test('create_csm_case should POST to case endpoint', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          result: { sys_id: 'case001', number: 'CS0000001' },
        }),
      });

      const result = await client.callTool({
        name: 'create_csm_case',
        arguments: {
          data: { short_description: 'Billing issue', priority: '2' },
        },
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      const [url, options] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/sn_customerservice/case');
      expect(options.method).toBe('POST');
      expect(result.isError).toBeUndefined();
    });

    test('get_csm_case should GET case by sys_id', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: { sys_id: 'case001', short_description: 'Billing issue' },
        }),
      });

      const result = await client.callTool({
        name: 'get_csm_case',
        arguments: { sys_id: 'case001' },
      });

      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/sn_customerservice/case/case001');
      expect(result.isError).toBeUndefined();
    });

    test('update_csm_case should PATCH case', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: { sys_id: 'case001', state: '2' },
        }),
      });

      const result = await client.callTool({
        name: 'update_csm_case',
        arguments: {
          sys_id: 'case001',
          data: { state: '2', priority: '1' },
        },
      });

      const [, options] = apiMock.mock.calls[0]!;
      expect(options.method).toBe('PATCH');
      expect(result.isError).toBeUndefined();
    });

    test('list_csm_accounts should GET accounts', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: [{ sys_id: 'acct001', name: 'Acme Corp' }],
        }),
      });

      const result = await client.callTool({
        name: 'list_csm_accounts',
        arguments: { limit: 10 },
      });

      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/now/account');
      expect(result.isError).toBeUndefined();
    });

    test('get_csm_account should GET account by sys_id', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: { sys_id: 'acct001', name: 'Acme Corp' },
        }),
      });

      const result = await client.callTool({
        name: 'get_csm_account',
        arguments: { sys_id: 'acct001' },
      });

      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/now/account/acct001');
      expect(result.isError).toBeUndefined();
    });

    test('list_csm_contacts should GET contacts with account filter', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: [{ sys_id: 'cont001', email: 'jane@acme.com' }],
        }),
      });

      const result = await client.callTool({
        name: 'list_csm_contacts',
        arguments: { account_sys_id: 'acct001', limit: 5 },
      });

      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/now/contact');
      expect(url).toContain('account%3Dacct001');
      expect(result.isError).toBeUndefined();
    });

    test('get_csm_contact should GET contact by sys_id', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: { sys_id: 'cont001', email: 'jane@acme.com' },
        }),
      });

      const result = await client.callTool({
        name: 'get_csm_contact',
        arguments: { sys_id: 'cont001' },
      });

      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/now/contact/cont001');
      expect(result.isError).toBeUndefined();
    });

    test('create_csm_order should POST to order endpoint', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          result: { sys_id: 'ord001', number: 'ORD0000001' },
        }),
      });

      const result = await client.callTool({
        name: 'create_csm_order',
        arguments: {
          data: { short_description: 'Hardware order', account: 'acct001' },
        },
      });

      const [url, options] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/sn_csm_order/order');
      expect(options.method).toBe('POST');
      expect(result.isError).toBeUndefined();
    });

    test('get_csm_order should GET order by sys_id', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: { sys_id: 'ord001', short_description: 'Hardware order' },
        }),
      });

      const result = await client.callTool({
        name: 'get_csm_order',
        arguments: { sys_id: 'ord001' },
      });

      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/sn_csm_order/order/ord001');
      expect(result.isError).toBeUndefined();
    });
  });

  describe('Batch API', () => {
    test('batch_api should POST batch requests', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: {
            serviced_requests: [
              { id: '1', status_code: 200, body: '{"result":[]}' },
              { id: '2', status_code: 200, body: '{"result":[]}' },
            ],
          },
        }),
      });

      const result = await client.callTool({
        name: 'batch_api',
        arguments: {
          requests: [
            { id: '1', method: 'GET', url: '/api/now/table/incident?sysparm_limit=1' },
            { id: '2', method: 'GET', url: '/api/now/table/change_request?sysparm_limit=1' },
          ],
        },
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      const [url, options] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/now/batch');
      expect(options.method).toBe('POST');
      expect(result.isError).toBeUndefined();
    });
  });

  describe('Incident Management', () => {
    test('create_incident should POST to incident table', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          result: { sys_id: 'inc001', number: 'INC0000001', short_description: 'Printer offline' },
        }),
      });

      const result = await client.callTool({
        name: 'create_incident',
        arguments: {
          short_description: 'Printer offline',
          category: 'hardware',
          impact: '3',
          urgency: '2',
        },
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      const [url, options] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/now/table/incident');
      expect(options.method).toBe('POST');
      const body = JSON.parse(options.body);
      expect(body.short_description).toBe('Printer offline');
      expect(body.category).toBe('hardware');
      expect(body.impact).toBe('3');
      expect(result.isError).toBeUndefined();
    });

    test('resolve_incident should PATCH with resolved state', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: { sys_id: 'inc001', state: '6', close_code: 'Solved (Permanently)' },
        }),
      });

      const result = await client.callTool({
        name: 'resolve_incident',
        arguments: {
          sys_id: 'inc001',
          close_code: 'Solved (Permanently)',
          close_notes: 'Replaced toner',
        },
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      const [url, options] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/now/table/incident/inc001');
      expect(options.method).toBe('PATCH');
      const body = JSON.parse(options.body);
      expect(body.state).toBe('6');
      expect(body.close_code).toBe('Solved (Permanently)');
      expect(result.isError).toBeUndefined();
    });
  });

  describe('Problem Management', () => {
    test('create_problem should POST to problem table', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          result: { sys_id: 'prb001', number: 'PRB0000001', short_description: 'Network drops' },
        }),
      });

      const result = await client.callTool({
        name: 'create_problem',
        arguments: {
          short_description: 'Network drops',
          impact: '2',
          urgency: '2',
        },
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      const [url, options] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/now/table/problem');
      expect(options.method).toBe('POST');
      expect(result.isError).toBeUndefined();
    });

    test('create_problem should link related incidents', async () => {
      // First call: create problem
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          result: { sys_id: 'prb001', number: 'PRB0000001' },
        }),
      });
      // Second call: patch incident to link
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: { sys_id: 'inc001', problem_id: 'prb001' },
        }),
      });

      const result = await client.callTool({
        name: 'create_problem',
        arguments: {
          short_description: 'Root cause analysis',
          related_incidents: ['inc001'],
        },
      });

      expect(apiMock).toHaveBeenCalledTimes(2);
      const [, patchOptions] = apiMock.mock.calls[1]!;
      expect(patchOptions.method).toBe('PATCH');
      const patchBody = JSON.parse(patchOptions.body);
      expect(patchBody.problem_id).toBe('prb001');
      expect(result.isError).toBeUndefined();
    });

    test('get_problem should fetch by sys_id', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: { sys_id: 'prb001', short_description: 'Network drops' },
        }),
      });

      const result = await client.callTool({
        name: 'get_problem',
        arguments: { sys_id: 'prb001' },
      });

      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/now/table/problem/prb001');
      expect(result.isError).toBeUndefined();
    });

    test('get_problem should fetch by number', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: [{ sys_id: 'prb001', number: 'PRB0040001' }],
        }),
      });

      const result = await client.callTool({
        name: 'get_problem',
        arguments: { number: 'PRB0040001' },
      });

      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/now/table/problem');
      expect(url).toContain('number%3DPRB0040001');
      expect(result.isError).toBeUndefined();
    });

    test('get_problem should error when neither sys_id nor number given', async () => {
      const result = await client.callTool({
        name: 'get_problem',
        arguments: {},
      });

      expect(apiMock).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
    });

    test('update_problem should PATCH with provided fields', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: { sys_id: 'prb001', state: '3', known_error: true },
        }),
      });

      const result = await client.callTool({
        name: 'update_problem',
        arguments: {
          sys_id: 'prb001',
          state: '3',
          known_error: true,
          workaround: 'Restart the service',
        },
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      const [url, options] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/now/table/problem/prb001');
      expect(options.method).toBe('PATCH');
      const body = JSON.parse(options.body);
      expect(body.state).toBe('3');
      expect(body.known_error).toBe(true);
      expect(body.workaround).toBe('Restart the service');
      expect(result.isError).toBeUndefined();
    });
  });

  describe('Service Request Management', () => {
    test('list_requests should GET sc_request with filters', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: [{ sys_id: 'req001', number: 'REQ0000001', request_state: 'approved' }],
        }),
      });

      const result = await client.callTool({
        name: 'list_requests',
        arguments: {
          request_state: 'approved',
          limit: 10,
        },
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/now/table/sc_request');
      expect(url).toContain('request_state%3Dapproved');
      expect(result.isError).toBeUndefined();
    });

    test('get_request_item should GET sc_req_item by sys_id', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: { sys_id: 'ritm001', number: 'RITM0000001' },
        }),
      });

      const result = await client.callTool({
        name: 'get_request_item',
        arguments: { sys_id: 'ritm001' },
      });

      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/now/table/sc_req_item/ritm001');
      expect(result.isError).toBeUndefined();
    });

    test('list_request_items should GET sc_req_item with filters', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: [{ sys_id: 'ritm001', stage: 'fulfillment' }],
        }),
      });

      const result = await client.callTool({
        name: 'list_request_items',
        arguments: {
          request: 'req001',
          stage: 'fulfillment',
          limit: 10,
        },
      });

      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/now/table/sc_req_item');
      expect(url).toContain('request%3Dreq001');
      expect(url).toContain('stage%3Dfulfillment');
      expect(result.isError).toBeUndefined();
    });
  });

  describe('Flow Designer', () => {
    test('execute_flow should POST to flow endpoint', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: { context_id: 'ctx001', execution_id: 'exec001' },
        }),
      });

      const result = await client.callTool({
        name: 'execute_flow',
        arguments: {
          scope: 'global',
          flow_name: 'onboard_new_hire',
          inputs: { employee_name: 'Jane Doe' },
        },
      });

      expect(apiMock).toHaveBeenCalledTimes(1);
      const [url, options] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/now/flow/global/onboard_new_hire');
      expect(options.method).toBe('POST');
      expect(result.isError).toBeUndefined();
    });

    test('execute_flow with wait_for_completion should poll until complete', async () => {
      // Initial POST returns context_id
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: { context_id: 'ctx999', execution_id: 'exec999' },
        }),
      });
      // First poll — still running
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: { state: 'running', outputs: {} },
        }),
      });
      // Second poll — complete
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: { state: 'complete', outputs: { result_key: 'done' } },
        }),
      });

      const result = await client.callTool({
        name: 'execute_flow',
        arguments: {
          scope: 'x_myapp',
          flow_name: 'approval_flow',
          inputs: { ticket_id: 'INC001' },
          wait_for_completion: true,
        },
      }) as ToolResult;

      // Initial POST + 2 polls
      expect(apiMock).toHaveBeenCalledTimes(3);
      // First call is the POST
      expect(apiMock.mock.calls[0]![0]).toContain('/api/now/flow/x_myapp/approval_flow');
      // Second call polls context
      expect(apiMock.mock.calls[1]![0]).toContain('/api/now/table/sys_flow_context/ctx999');
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.state).toBe('complete');
    });
  });

  // =========================================================================
  // RESPONSE CONTENT VERIFICATION
  // =========================================================================

  describe('Response Content', () => {
    test('list_records returns pretty-printed JSON array', async () => {
      const records = [
        { sys_id: 'r1', short_description: 'First' },
        { sys_id: 'r2', short_description: 'Second' },
      ];
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ result: records }),
      });

      const result = await client.callTool({
        name: 'list_records',
        arguments: { table: 'incident' },
      }) as ToolResult;

      expect(result.isError).toBeUndefined();
      expect(result.content[0]!.type).toBe('text');
      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed).toEqual(records);
      // Verify pretty-printed (has newlines and indentation)
      expect(result.content[0]!.text).toContain('\n');
      expect(result.content[0]!.text).toContain('  ');
    });

    test('delete_record returns confirmation message', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 204,
        json: async () => ({}),
      });

      const result = await client.callTool({
        name: 'delete_record',
        arguments: { table: 'incident', sys_id: 'del001' },
      }) as ToolResult;

      expect(result.isError).toBeUndefined();
      expect(result.content[0]!.text).toContain('del001');
      expect(result.content[0]!.text).toContain('deleted');
      expect(result.content[0]!.text).toContain('incident');
    });

    test('error response includes status code and detail message', async () => {
      apiMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: async () => ({
          error: {
            message: 'Insufficient rights',
            detail: 'User lacks write access to incident table',
          },
        }),
      });

      const result = await client.callTool({
        name: 'create_record',
        arguments: { table: 'incident', data: { short_description: 'test' } },
      }) as ToolResult;

      expect(result.isError).toBe(true);
      const text = result.content[0]!.text;
      expect(text).toContain('403');
      expect(text).toContain('Insufficient rights');
      expect(text).toContain('User lacks write access');
    });
  });

  // =========================================================================
  // QUERY PARAMETER CONSTRUCTION
  // =========================================================================

  describe('Query Parameter Construction', () => {
    test('list_records passes all optional params as query string', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ result: [] }),
      });

      await client.callTool({
        name: 'list_records',
        arguments: {
          table: 'change_request',
          query: 'active=true^priority=1',
          fields: 'number,short_description,state',
          limit: 50,
          offset: 100,
          display_value: 'all',
        },
      });

      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('sysparm_query=active%3Dtrue%5Epriority%3D1');
      expect(url).toContain('sysparm_fields=number%2Cshort_description%2Cstate');
      expect(url).toContain('sysparm_limit=50');
      expect(url).toContain('sysparm_offset=100');
      expect(url).toContain('sysparm_display_value=all');
      expect(url).toContain('sysparm_exclude_reference_link=true');
    });

    test('list_records defaults limit to 10 when not specified', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ result: [] }),
      });

      await client.callTool({
        name: 'list_records',
        arguments: { table: 'incident' },
      });

      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('sysparm_limit=10');
    });

    test('aggregate_records passes group_by, having, and order_by', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ result: { stats: { count: 10 } } }),
      });

      await client.callTool({
        name: 'aggregate_records',
        arguments: {
          table: 'incident',
          query: 'active=true',
          avg_fields: 'reassignment_count',
          sum_fields: 'priority',
          min_fields: 'opened_at',
          max_fields: 'closed_at',
          group_by: 'priority,state',
          having: 'count^priority^>^3',
          order_by: 'COUNT^DESC',
          display_value: 'true',
        },
      });

      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('sysparm_avg_fields=reassignment_count');
      expect(url).toContain('sysparm_sum_fields=priority');
      expect(url).toContain('sysparm_min_fields=opened_at');
      expect(url).toContain('sysparm_max_fields=closed_at');
      expect(url).toContain('sysparm_group_by=priority%2Cstate');
      expect(url).toContain('sysparm_having=count%5Epriority%5E%3E%5E3');
      expect(url).toContain('sysparm_order_by=COUNT%5EDESC');
      expect(url).toContain('sysparm_display_value=true');
    });

    test('list_attachments combines table_name, table_sys_id, and query into sysparm_query', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ result: [] }),
      });

      await client.callTool({
        name: 'list_attachments',
        arguments: {
          table_name: 'incident',
          table_sys_id: 'inc001',
          query: 'content_type=application/pdf',
          limit: 50,
          offset: 10,
        },
      });

      const [url] = apiMock.mock.calls[0]!;
      // All three parts should be joined with ^
      expect(url).toContain('table_name%3Dincident%5Etable_sys_id%3Dinc001%5Econtent_type%3Dapplication%2Fpdf');
      expect(url).toContain('sysparm_limit=50');
      expect(url).toContain('sysparm_offset=10');
    });

    test('list_requests combines request_state and requested_for filters', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ result: [] }),
      });

      await client.callTool({
        name: 'list_requests',
        arguments: {
          requested_for: 'user001',
          request_state: 'approved',
          fields: 'number,request_state',
          display_value: 'true',
        },
      });

      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('requested_for%3Duser001');
      expect(url).toContain('request_state%3Dapproved');
      expect(url).toContain('sysparm_fields=number%2Crequest_state');
      expect(url).toContain('sysparm_display_value=true');
    });

    test('list_request_items combines request, cat_item, and stage filters', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ result: [] }),
      });

      await client.callTool({
        name: 'list_request_items',
        arguments: {
          request: 'req001',
          cat_item: 'cat001',
          stage: 'fulfillment',
          query: 'priority=1',
        },
      });

      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('request%3Dreq001');
      expect(url).toContain('cat_item%3Dcat001');
      expect(url).toContain('stage%3Dfulfillment');
      expect(url).toContain('priority%3D1');
    });

    test('list_catalog_items passes catalog and category filters', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ result: [] }),
      });

      await client.callTool({
        name: 'list_catalog_items',
        arguments: {
          search: 'monitor',
          catalog_sys_id: 'cat_sys001',
          category_sys_id: 'cat_cat001',
          limit: 5,
          offset: 10,
        },
      });

      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('sysparm_text=monitor');
      expect(url).toContain('sysparm_catalog=cat_sys001');
      expect(url).toContain('sysparm_category=cat_cat001');
      expect(url).toContain('sysparm_limit=5');
      expect(url).toContain('sysparm_offset=10');
    });

    test('order_catalog_item passes quantity, variables, and requested_for', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ result: { sys_id: 'req001' } }),
      });

      await client.callTool({
        name: 'order_catalog_item',
        arguments: {
          sys_id: 'cat001',
          quantity: 3,
          variables: { urgency: '1', comments: 'Rush order' },
          requested_for: 'user001',
        },
      });

      const [, options] = apiMock.mock.calls[0]!;
      const body = JSON.parse(options.body);
      expect(body.sysparm_quantity).toBe('3');
      expect(body.variables).toEqual({ urgency: '1', comments: 'Rush order' });
      expect(body.sysparm_requested_for).toBe('user001');
    });
  });

  // =========================================================================
  // CONDITIONAL / BRANCHING LOGIC
  // =========================================================================

  describe('Conditional Logic', () => {
    test('get_problem by number queries with sysparm_query filter', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: [{ sys_id: 'prb001', number: 'PRB0040001', short_description: 'Root cause' }],
        }),
      });

      const result = await client.callTool({
        name: 'get_problem',
        arguments: { number: 'PRB0040001', fields: 'number,short_description', display_value: 'true' },
      }) as ToolResult;

      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('number%3DPRB0040001');
      expect(url).toContain('sysparm_limit=1');
      expect(url).toContain('sysparm_fields=number%2Cshort_description');
      expect(url).toContain('sysparm_display_value=true');
      // Should return the first (and only) array element, not the array itself
      const parsed = JSON.parse(result.content[0]!.text);
      expect(parsed.number).toBe('PRB0040001');
      expect(parsed.sys_id).toBe('prb001');
    });

    test('get_problem returns error when record not found by number', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ result: [] }),
      });

      const result = await client.callTool({
        name: 'get_problem',
        arguments: { number: 'PRB9999999' },
      }) as ToolResult;

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('not found');
    });

    test('create_change_request with standard type includes template id in body', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          result: { sys_id: 'chg002', number: 'CHG0000002', type: 'standard' },
        }),
      });

      await client.callTool({
        name: 'create_change_request',
        arguments: {
          type: 'standard',
          data: { short_description: 'Routine patching' },
          standard_change_template_id: 'tmpl_001',
        },
      });

      const [url, options] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/sn_chg_rest/change/standard');
      const body = JSON.parse(options.body);
      expect(body.std_change_producer_version).toBe('tmpl_001');
      expect(body.short_description).toBe('Routine patching');
    });

    test('create_change_request with emergency type uses emergency endpoint', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          result: { sys_id: 'chg003', type: 'emergency' },
        }),
      });

      await client.callTool({
        name: 'create_change_request',
        arguments: {
          type: 'emergency',
          data: { short_description: 'Critical security patch', justification: 'CVE-2026-9999' },
        },
      });

      const [url, options] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/sn_chg_rest/change/emergency');
      const body = JSON.parse(options.body);
      expect(body.short_description).toBe('Critical security patch');
      // standard_change_template_id should NOT be in body for emergency
      expect(body.std_change_producer_version).toBeUndefined();
    });

    test('create_incident maps configuration_item to cmdb_ci field', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          result: { sys_id: 'inc002', cmdb_ci: 'ci001' },
        }),
      });

      await client.callTool({
        name: 'create_incident',
        arguments: {
          short_description: 'Server down',
          description: 'Production server unresponsive',
          category: 'hardware',
          subcategory: 'server',
          impact: '1',
          urgency: '1',
          assignment_group: 'grp001',
          assigned_to: 'user001',
          configuration_item: 'ci001',
          caller_id: 'caller001',
          additional_fields: { contact_type: 'phone' },
        },
      });

      const [, options] = apiMock.mock.calls[0]!;
      const body = JSON.parse(options.body);
      expect(body.short_description).toBe('Server down');
      expect(body.description).toBe('Production server unresponsive');
      expect(body.cmdb_ci).toBe('ci001');
      expect(body.category).toBe('hardware');
      expect(body.subcategory).toBe('server');
      expect(body.impact).toBe('1');
      expect(body.urgency).toBe('1');
      expect(body.assignment_group).toBe('grp001');
      expect(body.assigned_to).toBe('user001');
      expect(body.caller_id).toBe('caller001');
      expect(body.contact_type).toBe('phone');
    });

    test('resolve_incident includes resolved_by when provided', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: { sys_id: 'inc001', state: '6' },
        }),
      });

      await client.callTool({
        name: 'resolve_incident',
        arguments: {
          sys_id: 'inc001',
          close_code: 'Solved (Permanently)',
          close_notes: 'Fixed the issue',
          resolved_by: 'resolver001',
        },
      });

      const [, options] = apiMock.mock.calls[0]!;
      const body = JSON.parse(options.body);
      expect(body.state).toBe('6');
      expect(body.incident_state).toBe('6');
      expect(body.resolved_by).toBe('resolver001');
    });

    test('update_problem correctly sets known_error boolean and all optional fields', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: { sys_id: 'prb001', state: '4', known_error: true },
        }),
      });

      await client.callTool({
        name: 'update_problem',
        arguments: {
          sys_id: 'prb001',
          state: '4',
          cause_notes: 'Memory leak in service X',
          fix_notes: 'Upgraded to v2.1',
          workaround: 'Restart service every 4 hours',
          known_error: true,
          assignment_group: 'grp001',
          assigned_to: 'user001',
          additional_fields: { priority: '1' },
        },
      });

      const [url, options] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/now/table/problem/prb001');
      const body = JSON.parse(options.body);
      expect(body.state).toBe('4');
      expect(body.cause_notes).toBe('Memory leak in service X');
      expect(body.fix_notes).toBe('Upgraded to v2.1');
      expect(body.workaround).toBe('Restart service every 4 hours');
      expect(body.known_error).toBe(true);
      expect(body.assignment_group).toBe('grp001');
      expect(body.assigned_to).toBe('user001');
      expect(body.priority).toBe('1');
    });

    test('create_problem with configuration_item maps to cmdb_ci', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          result: { sys_id: 'prb002' },
        }),
      });

      await client.callTool({
        name: 'create_problem',
        arguments: {
          short_description: 'Root cause for server crashes',
          configuration_item: 'ci_server001',
        },
      });

      const [, options] = apiMock.mock.calls[0]!;
      const body = JSON.parse(options.body);
      expect(body.cmdb_ci).toBe('ci_server001');
    });

    test('list_csm_contacts combines account_sys_id and query into sysparm_query', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ result: [] }),
      });

      await client.callTool({
        name: 'list_csm_contacts',
        arguments: {
          account_sys_id: 'acct001',
          query: 'active=true',
          limit: 10,
          offset: 5,
        },
      });

      const [url] = apiMock.mock.calls[0]!;
      // Should combine both filters with ^
      expect(url).toContain('account%3Dacct001%5Eactive%3Dtrue');
      expect(url).toContain('sysparm_limit=10');
      expect(url).toContain('sysparm_offset=5');
    });
  });

  // =========================================================================
  // TABLE ENCODING & SPECIAL CHARACTERS
  // =========================================================================

  describe('URL Encoding', () => {
    test('table names with special characters are URL-encoded', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ result: [] }),
      });

      await client.callTool({
        name: 'list_records',
        arguments: { table: 'u_custom table' },
      });

      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('u_custom%20table');
    });

    test('sys_id values are URL-encoded in path', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ result: { sys_id: 'abc/def' } }),
      });

      await client.callTool({
        name: 'get_record',
        arguments: { table: 'incident', sys_id: 'abc/def' },
      });

      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('abc%2Fdef');
    });
  });

  // =========================================================================
  // BATCH API DETAILS
  // =========================================================================

  describe('Batch API Details', () => {
    test('batch_api sends exact request structure and options', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: {
            serviced_requests: [
              { id: '1', status_code: 200, body: '{"result":{"count":5}}' },
            ],
          },
        }),
      });

      const result = await client.callTool({
        name: 'batch_api',
        arguments: {
          requests: [
            {
              id: '1',
              method: 'GET',
              url: '/api/now/stats/incident?sysparm_count=true',
              headers: { Accept: 'application/json' },
            },
          ],
        },
      }) as ToolResult;

      const [url, options] = apiMock.mock.calls[0]!;
      expect(url).toContain('/api/now/batch');
      const body = JSON.parse(options.body);
      expect(body.batch_request_payload).toBeDefined();
      expect(body.batch_request_payload.serviced_requests).toHaveLength(1);
      expect(body.batch_request_payload.serviced_requests[0].url).toBe('/api/now/stats/incident?sysparm_count=true');
      // Headers should be mapped to [{name, value}] format
      expect(body.batch_request_payload.serviced_requests[0].headers).toEqual([
        { name: 'Accept', value: 'application/json' },
      ]);
      expect(result.isError).toBeUndefined();
    });
  });

  // =========================================================================
  // KNOWLEDGE API DETAILS
  // =========================================================================

  describe('Knowledge API Query Params', () => {
    test('search_knowledge_articles passes limit and offset', async () => {
      apiMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ result: [] }),
      });

      await client.callTool({
        name: 'search_knowledge_articles',
        arguments: {
          query: 'VPN setup',
          limit: 5,
          offset: 10,
        },
      });

      const [url] = apiMock.mock.calls[0]!;
      expect(url).toContain('VPN');
      expect(url).toContain('sysparm_limit=5');
      expect(url).toContain('sysparm_offset=10');
    });
  });
});
