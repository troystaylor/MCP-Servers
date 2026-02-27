/**
 * Integration tests — HTTP transport + OAuth flow
 *
 * Starts the Express server on a random port and exercises
 * discovery endpoints, auth enforcement, and security headers.
 *
 * ServiceNow API calls are mocked to avoid external dependencies.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

let serverProcess: ChildProcess;
let baseUrl: string;

const PORT = 30_000 + randomInt(10_000);

beforeAll(async () => {
  baseUrl = `http://localhost:${PORT}`;

  const distDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'dist',
  );

  serverProcess = spawn('node', [path.join(distDir, 'http.js')], {
    env: {
      ...process.env,
      MCP_PORT: String(PORT),
      MCP_SERVER_URL: baseUrl,
      SERVICENOW_USERNAME: 'test_user',
      SERVICENOW_PASSWORD: 'test_password',
      SERVICENOW_CLIENT_ID: 'test_client_id',
      SERVICENOW_CLIENT_SECRET: 'test_client_secret',
      BETTER_AUTH_SECRET: 'integration-test-secret-value',
      ENABLE_OBSERVABILITY: 'false',
      NODE_ENV: 'test',
    },
    stdio: 'pipe',
  });

  // Wait for server to emit a listening message
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server startup timed out')), 10_000);
    serverProcess.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.includes('listening on port')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    serverProcess.stderr?.on('data', (chunk: Buffer) => {
      console.error('[server stderr]', chunk.toString());
    });
    serverProcess.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    serverProcess.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timeout);
        reject(new Error(`Server exited with code ${code}`));
      }
    });
  });

  // Poll health endpoint to confirm the server is accepting connections
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}, 20_000);

afterAll(async () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill('SIGTERM');
    await once(serverProcess, 'exit').catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchJson(urlPath: string, init?: RequestInit) {
  const res = await fetch(`${baseUrl}${urlPath}`, init);
  const body = await res.json();
  return { status: res.status, headers: res.headers, body };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HTTP Integration', () => {
  // -----------------------------------------------------------------------
  // Discovery endpoints
  // -----------------------------------------------------------------------

  describe('Discovery', () => {
    test('GET /.well-known/oauth-authorization-server returns AS metadata', async () => {
      const { status, body } = await fetchJson('/.well-known/oauth-authorization-server');

      expect(status).toBe(200);
      expect(body.issuer).toBe(baseUrl);
      expect(body.authorization_endpoint).toContain('/api/auth/mcp/authorize');
      expect(body.token_endpoint).toContain('/api/auth/mcp/token');
      expect(body.registration_endpoint).toContain('/api/auth/mcp/register');
      expect(body.code_challenge_methods_supported).toContain('S256');
    });

    test('GET /.well-known/oauth-protected-resource returns PRM', async () => {
      const { status, body } = await fetchJson('/.well-known/oauth-protected-resource');

      expect(status).toBe(200);
      expect(body.resource).toBe(`${baseUrl}/mcp`);
      expect(body.authorization_servers).toContain(baseUrl);
    });

    test('GET /.well-known/oauth-protected-resource/mcp returns PRM (RFC 9728 derived path)', async () => {
      const { status, body } = await fetchJson('/.well-known/oauth-protected-resource/mcp');

      expect(status).toBe(200);
      expect(body.resource).toBe(`${baseUrl}/mcp`);
      expect(body.authorization_servers).toContain(baseUrl);
    });

    test('both PRM paths return identical content', async () => {
      const bare = await fetchJson('/.well-known/oauth-protected-resource');
      const mcp = await fetchJson('/.well-known/oauth-protected-resource/mcp');

      expect(bare.body).toEqual(mcp.body);
    });
  });

  // -----------------------------------------------------------------------
  // Health
  // -----------------------------------------------------------------------

  describe('Health', () => {
    test('GET /health returns ok', async () => {
      const { status, body } = await fetchJson('/health');

      expect(status).toBe(200);
      expect(body.status).toBe('ok');
    });
  });

  // -----------------------------------------------------------------------
  // Auth enforcement
  // -----------------------------------------------------------------------

  describe('Auth Enforcement', () => {
    test('POST /mcp without token returns 401 with WWW-Authenticate', async () => {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1 }),
      });

      expect(res.status).toBe(401);
      const wwwAuth = res.headers.get('www-authenticate');
      expect(wwwAuth).toBeTruthy();
      expect(wwwAuth).toContain('resource_metadata');
    });
  });

  // -----------------------------------------------------------------------
  // Security headers
  // -----------------------------------------------------------------------

  describe('Security Headers', () => {
    test('responses include hardening headers', async () => {
      const res = await fetch(`${baseUrl}/health`);

      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('strict-transport-security')).toContain('max-age=');
    });

    test('X-Powered-By header is suppressed', async () => {
      const res = await fetch(`${baseUrl}/health`);

      expect(res.headers.has('x-powered-by')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // DCR + OAuth flow
  // -----------------------------------------------------------------------

  describe('OAuth Flow', () => {
    test('dynamic client registration succeeds', async () => {
      const res = await fetch(`${baseUrl}/api/auth/mcp/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'integration-test',
          redirect_uris: ['http://localhost:9999/callback'],
          grant_types: ['authorization_code'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.client_id).toBeTruthy();
      expect(body.redirect_uris).toContain('http://localhost:9999/callback');
    });
  });

  // -----------------------------------------------------------------------
  // End-to-end OAuth flow: DCR → PKCE → authorize → sign-in → token → MCP
  // -----------------------------------------------------------------------

  describe('End-to-End OAuth Flow', () => {
    test('full DCR → authorize → token → MCP call succeeds', async () => {
      const REDIRECT_URI = 'http://localhost:9999/callback';

      // --- Step 1: Dynamic Client Registration ---
      const dcrRes = await fetch(`${baseUrl}/api/auth/mcp/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'e2e-test-client',
          redirect_uris: [REDIRECT_URI],
          grant_types: ['authorization_code'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
      });

      expect(dcrRes.status).toBe(201);
      const dcrBody = await dcrRes.json();
      const clientId: string = dcrBody.client_id;
      expect(clientId).toBeTruthy();

      // --- Step 2: Generate PKCE challenge ---
      const codeVerifier = randomBytes(32).toString('base64url');
      const codeChallenge = createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');
      const state = randomBytes(16).toString('hex');

      // --- Step 3: Start authorization flow ---
      // The /api/auth/mcp/authorize endpoint will redirect to /sign-in
      // because there is no active session. We follow redirects manually
      // to capture cookies at each step.
      const authorizeParams = new URLSearchParams({
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: 'openid',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });

      const authorizeRes = await fetch(
        `${baseUrl}/api/auth/mcp/authorize?${authorizeParams}`,
        { redirect: 'manual' },
      );

      // Should redirect to /sign-in (or similar)
      expect([301, 302, 303, 307, 308]).toContain(authorizeRes.status);
      const signInLocation = authorizeRes.headers.get('location')!;
      expect(signInLocation).toBeTruthy();

      // Collect cookies from the authorize redirect
      let cookies = collectCookies(authorizeRes);

      // --- Step 4: Follow redirect to /sign-in ---
      // The sign-in page auto-creates a demo user, signs in, sets session
      // cookies, and redirects back to /api/auth/mcp/authorize
      const signInUrl = signInLocation.startsWith('http')
        ? signInLocation
        : `${baseUrl}${signInLocation}`;

      const signInRes = await fetch(signInUrl, {
        redirect: 'manual',
        headers: { Cookie: cookies },
      });

      expect([301, 302, 303, 307, 308]).toContain(signInRes.status);
      // Merge new cookies from sign-in response
      cookies = mergeCookies(cookies, signInRes);

      const postSignInLocation = signInRes.headers.get('location')!;
      expect(postSignInLocation).toBeTruthy();

      // --- Step 5: Follow redirect back to authorize (now with session) ---
      const authCallbackUrl = postSignInLocation.startsWith('http')
        ? postSignInLocation
        : `${baseUrl}${postSignInLocation}`;

      const authCallbackRes = await fetch(authCallbackUrl, {
        redirect: 'manual',
        headers: { Cookie: cookies },
      });

      // If the server requires consent, it might show a consent page.
      // Otherwise, it redirects to redirect_uri with code.
      // Handle potential multi-step redirects.
      let finalRedirectUrl: string;
      if ([301, 302, 303, 307, 308].includes(authCallbackRes.status)) {
        finalRedirectUrl = authCallbackRes.headers.get('location')!;
        // The redirect may still be internal; follow until we reach the callback
        if (finalRedirectUrl.startsWith(baseUrl) && !finalRedirectUrl.includes(REDIRECT_URI)) {
          cookies = mergeCookies(cookies, authCallbackRes);
          const nextRes = await fetch(finalRedirectUrl, {
            redirect: 'manual',
            headers: { Cookie: cookies },
          });
          expect([301, 302, 303, 307, 308]).toContain(nextRes.status);
          finalRedirectUrl = nextRes.headers.get('location')!;
        }
      } else {
        // Might auto-approve and return the location directly
        finalRedirectUrl = authCallbackRes.headers.get('location') ?? '';
      }

      // --- Step 6: Extract authorization code from redirect ---
      expect(finalRedirectUrl).toContain(REDIRECT_URI);
      const callbackUrl = new URL(finalRedirectUrl);
      const authCode = callbackUrl.searchParams.get('code');
      const returnedState = callbackUrl.searchParams.get('state');

      expect(authCode).toBeTruthy();
      expect(returnedState).toBe(state);

      // --- Step 7: Exchange code for access token ---
      const tokenRes = await fetch(`${baseUrl}/api/auth/mcp/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: authCode!,
          redirect_uri: REDIRECT_URI,
          client_id: clientId,
          code_verifier: codeVerifier,
        }).toString(),
      });

      expect(tokenRes.status).toBe(200);
      const tokenBody = await tokenRes.json();
      const accessToken: string = tokenBody.access_token;
      expect(accessToken).toBeTruthy();
      expect(tokenBody.token_type?.toLowerCase()).toBe('bearer');

      // --- Step 8: Make an authenticated MCP call ---
      const mcpRes = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'initialize',
          id: 1,
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'e2e-test', version: '1.0.0' },
          },
        }),
      });

      expect(mcpRes.status).toBe(200);

      // Response may be JSON or SSE depending on server preference
      const contentType = mcpRes.headers.get('content-type') ?? '';
      let mcpBody: Record<string, unknown>;

      if (contentType.includes('text/event-stream')) {
        // Parse SSE — find the "message" event's data line
        const sseText = await mcpRes.text();
        const dataLine = sseText
          .split('\n')
          .find((line: string) => line.startsWith('data: '));
        expect(dataLine).toBeTruthy();
        mcpBody = JSON.parse(dataLine!.slice(6));
      } else {
        mcpBody = await mcpRes.json();
      }

      expect(mcpBody.result).toBeTruthy();
      const result = mcpBody.result as Record<string, unknown>;
      expect(result.protocolVersion).toBeTruthy();
      expect(result.serverInfo).toBeTruthy();
      const serverInfo = result.serverInfo as Record<string, string>;
      expect(serverInfo.name).toContain('servicenow');
    }, 15_000);
  });
});

// ---------------------------------------------------------------------------
// Cookie helpers — track Set-Cookie headers across redirects
// ---------------------------------------------------------------------------

function collectCookies(res: Response): string {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  return setCookies
    .map((c: string) => c.split(';')[0]!)
    .join('; ');
}

function mergeCookies(existing: string, res: Response): string {
  const newCookies = collectCookies(res);
  if (!newCookies) return existing;
  if (!existing) return newCookies;

  // Parse existing into a map, then overlay new values
  const map = new Map<string, string>();
  for (const pair of existing.split('; ')) {
    const [key] = pair.split('=', 1);
    if (key) map.set(key, pair);
  }
  for (const pair of newCookies.split('; ')) {
    const [key] = pair.split('=', 1);
    if (key) map.set(key, pair);
  }
  return [...map.values()].join('; ');
}
