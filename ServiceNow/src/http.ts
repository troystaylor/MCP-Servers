/**
 * ServiceNow MCP Server — HTTP Transport Entry Point
 *
 * Streamable HTTP transport with per-session McpServer instances,
 * supporting POST (messages), GET (SSE streams), and DELETE (session close).
 *
 * OAuth 2.0 dynamic discovery is enabled — all /mcp endpoints require a
 * valid Bearer token. Clients discover the authorization server via
 * /.well-known/oauth-protected-resource/mcp (RFC 9728).
 *
 * Compatible with the Copilot Studio MCP Streamable HTTP connector
 * using the "OAuth 2.0 (Dynamic discovery)" authentication option.
 *
 * Run with: node dist/http.js
 *
 * Environment variables:
 *   - MCP_PORT: Port to listen on (default: 3000)
 *   - MCP_SERVER_URL: External URL of this server (required for OAuth metadata)
 *   - SERVICENOW_USERNAME: ServiceNow username (OAuth resource owner)
 *   - SERVICENOW_PASSWORD: ServiceNow password
 *   - SERVICENOW_CLIENT_ID: ServiceNow OAuth client ID
 *   - SERVICENOW_CLIENT_SECRET: ServiceNow OAuth client secret
 */

import { randomUUID } from 'node:crypto';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Express } from 'express';
import cors from 'cors';
import express from 'express';

import { mountAuthRoutes, requireBearerAuth } from './auth.js';
import { initObservability, startInvokeScope, setBaggage, shutdownObservability } from './observability.js';
import { createServer } from './server.js';

// Initialize Agent 365 observability (must be before any tracing)
initObservability();

const PORT = process.env.MCP_PORT ? Number.parseInt(process.env.MCP_PORT, 10) : 3000;
const SERVER_URL = process.env.MCP_SERVER_URL ?? `http://localhost:${PORT}`;

export const app: Express = express();

// Trust the Azure Container Apps reverse proxy for correct client IPs
app.set('trust proxy', 1);

// Suppress X-Powered-By header — prevents server tech fingerprinting
app.disable('x-powered-by');

// Security headers — defense-in-depth for the HTTP transport
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// CORS — expose MCP-required + OAuth headers (must be first)
app.use(
  cors({
    exposedHeaders: ['WWW-Authenticate', 'Mcp-Session-Id', 'Mcp-Protocol-Version'],
  }),
);

// OAuth routes — MUST be mounted before express.json() because
// better-auth's toNodeHandler reads the raw request body.
await mountAuthRoutes(app, SERVER_URL);

// Parse JSON bodies for MCP POST requests (after auth routes)
app.use(express.json({ limit: '1mb' }));

// Session-to-transport mapping for stateful connections
const MAX_SESSIONS = 1000;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

const transports = new Map<string, StreamableHTTPServerTransport>();
const sessionLastAccess = new Map<string, number>();

/** UUID v4 format check for session IDs. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isValidSessionId(id: string): boolean {
  return UUID_RE.test(id);
}

/** Evict sessions that haven't been accessed within the TTL. */
function evictStaleSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [sid, lastAccess] of sessionLastAccess) {
    if (lastAccess < cutoff) {
      const transport = transports.get(sid);
      if (transport) {
        transport.close?.();
        transports.delete(sid);
      }
      sessionLastAccess.delete(sid);
      console.log(`Session evicted (stale): ${sid}`);
    }
  }
}

// Periodic stale session cleanup every 5 minutes
const evictionInterval = setInterval(evictStaleSessions, 5 * 60 * 1000);
evictionInterval.unref();

// Bearer auth middleware — protects all /mcp endpoints
const authMiddleware = requireBearerAuth({
  resourceMetadataUrl: new URL(`${SERVER_URL}/.well-known/oauth-protected-resource/mcp`),
});

// Health check (no auth required)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', server: 'servicenow-mcp-server' });
});

// POST /mcp — Initialize sessions or send JSON-RPC messages
app.post('/mcp', authMiddleware, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  // Validate session ID format if provided
  if (sessionId && !isValidSessionId(sessionId)) {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32_000, message: 'Bad Request: Invalid session ID format' },
      id: null,
    });
    return;
  }

  const baggageScope = setBaggage(sessionId ?? 'init');

  await baggageScope.run(async () => {
    const invokeScope = startInvokeScope(sessionId ?? 'init');

    try {
      // Existing session — delegate to its transport
      if (sessionId && transports.has(sessionId)) {
        sessionLastAccess.set(sessionId, Date.now());
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res, req.body);
        invokeScope.recordResponse('delegated');
        return;
      }

      // New session — must be an initialize request
      if (!isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32_000, message: 'Bad Request: No valid session ID provided' },
          id: null,
        });
        return;
      }

      // Enforce session cap
      if (transports.size >= MAX_SESSIONS) {
        evictStaleSessions();
        if (transports.size >= MAX_SESSIONS) {
          res.status(503).json({
            jsonrpc: '2.0',
            error: { code: -32_000, message: 'Server busy: too many active sessions' },
            id: null,
          });
          return;
        }
      }

      // Create a new transport + server pair for this session
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          console.log(`Session initialized: ${newSessionId}`);
          transports.set(newSessionId, transport);
          sessionLastAccess.set(newSessionId, Date.now());
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          console.log(`Session closed: ${sid}`);
          transports.delete(sid);
          sessionLastAccess.delete(sid);
        }
      };

      // Each session gets its own McpServer instance
      const server = createServer();
      await server.connect(transport);

      await transport.handleRequest(req, res, req.body);
      invokeScope.recordResponse('initialized');
    } catch (err) {
      if (err instanceof Error) invokeScope.recordError(err);
      console.error('Error handling MCP POST:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32_603, message: 'Internal server error' },
          id: null,
        });
      }
    } finally {
      invokeScope.dispose();
    }
  });
});

// GET /mcp — SSE stream for server-to-client notifications
app.get('/mcp', authMiddleware, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !isValidSessionId(sessionId) || !transports.has(sessionId)) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }

  sessionLastAccess.set(sessionId, Date.now());
  const transport = transports.get(sessionId)!;
  await transport.handleRequest(req, res);
});

// DELETE /mcp — Session termination
app.delete('/mcp', authMiddleware, async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !isValidSessionId(sessionId) || !transports.has(sessionId)) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }

  sessionLastAccess.delete(sessionId);
  const transport = transports.get(sessionId)!;
  await transport.handleRequest(req, res);
});

// Only start listening when run directly (not imported by tests)
const isDirectRun =
  process.argv[1]?.endsWith('/http.js') || process.argv[1]?.endsWith('\\http.js');

if (isDirectRun) {
  app.listen(PORT, () => {
    console.log(`ServiceNow MCP Server (HTTP) listening on port ${PORT}`);
    console.log(`  Server URL: ${SERVER_URL}`);
    console.log('Endpoints:');
    console.log('  POST   /mcp    — MCP protocol (initialize + messages)  [OAuth]');
    console.log('  GET    /mcp    — SSE stream (server notifications)     [OAuth]');
    console.log('  DELETE /mcp    — Session termination                   [OAuth]');
    console.log('  GET    /health — Health check');
    console.log('  Observability: Agent 365 tracing enabled');
  });
}

async function gracefulShutdown(signal: string): Promise<void> {
  console.log(`Received ${signal}, shutting down...`);
  clearInterval(evictionInterval);
  for (const [sid, transport] of transports) {
    transport.close?.();
    transports.delete(sid);
    sessionLastAccess.delete(sid);
  }
  await shutdownObservability();
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
