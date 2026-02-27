/**
 * ServiceNow MCP Server — Stdio Transport Entry Point
 *
 * This module starts the MCP server with stdio transport for use with
 * Claude Desktop and other MCP clients that communicate via stdin/stdout.
 *
 * Run with: node dist/index.js
 *
 * Environment variables:
 *   - SERVICENOW_INSTANCE_URL: ServiceNow instance URL (required)
 *   - SERVICENOW_USERNAME: ServiceNow username
 *   - SERVICENOW_PASSWORD: ServiceNow password
 *   - SERVICENOW_AUTH_TYPE: "basic" or "oauth" (default: "basic")
 *   - SERVICENOW_CLIENT_ID: OAuth client ID (required for oauth)
 *   - SERVICENOW_CLIENT_SECRET: OAuth client secret (required for oauth)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createServer } from './server.js';

async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  // Keep process alive until transport closes
  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
