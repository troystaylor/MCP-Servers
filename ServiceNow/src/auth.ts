/**
 * OAuth 2.0 Authentication for ServiceNow MCP Server
 *
 * Implements the MCP authorization spec with dynamic discovery:
 * - Protected Resource Metadata (RFC 9728) at /.well-known/oauth-protected-resource/mcp
 * - OAuth Authorization Server Metadata (RFC 8414) at /.well-known/oauth-authorization-server
 * - Dynamic Client Registration (DCR) at /api/auth/mcp/register
 * - Bearer token validation middleware for /mcp routes
 *
 * Uses better-auth with the MCP plugin and in-memory SQLite.
 * All OAuth state (clients, tokens) is lost on server restart.
 */

import { randomBytes } from 'node:crypto';

import type { BetterAuthOptions } from 'better-auth';
import { betterAuth } from 'better-auth';
import { toNodeHandler } from 'better-auth/node';
import { mcp, oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata } from 'better-auth/plugins';
import { createClient, type Client } from '@libsql/client';
import { LibsqlDialect } from '@libsql/kysely-libsql';
import cors from 'cors';
import type { Express, NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';

// --- Types ---

type Auth = ReturnType<typeof betterAuth>;

// --- Module State ---

let auth: Auth | null = null;
let demoUserCreated = false;

const DEMO_PASSWORD = randomBytes(16).toString('base64url');
const DEMO_USER = {
  email: 'demo@example.com',
  password: DEMO_PASSWORD,
  name: 'Demo User',
};

// --- Database Schema ---

async function createDatabase(): Promise<Client> {
  const client = createClient({ url: ':memory:' });

  // Core better-auth tables
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS user (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      emailVerified INTEGER NOT NULL DEFAULT 0,
      image TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      expiresAt TEXT NOT NULL,
      ipAddress TEXT,
      userAgent TEXT,
      userId TEXT NOT NULL REFERENCES user(id),
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS account (
      id TEXT PRIMARY KEY,
      accountId TEXT NOT NULL,
      providerId TEXT NOT NULL,
      userId TEXT NOT NULL REFERENCES user(id),
      accessToken TEXT,
      refreshToken TEXT,
      idToken TEXT,
      accessTokenExpiresAt TEXT,
      refreshTokenExpiresAt TEXT,
      scope TEXT,
      password TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS verification (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL,
      value TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      createdAt TEXT,
      updatedAt TEXT
    );
  `);

  // OIDC / MCP plugin tables
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS oauthApplication (
      id TEXT PRIMARY KEY,
      name TEXT,
      icon TEXT,
      metadata TEXT,
      clientId TEXT NOT NULL UNIQUE,
      clientSecret TEXT,
      redirectUrls TEXT NOT NULL,
      type TEXT NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0,
      userId TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauthAccessToken (
      id TEXT PRIMARY KEY,
      accessToken TEXT NOT NULL UNIQUE,
      refreshToken TEXT UNIQUE,
      accessTokenExpiresAt TEXT NOT NULL,
      refreshTokenExpiresAt TEXT,
      clientId TEXT NOT NULL,
      userId TEXT,
      scopes TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauthRefreshToken (
      id TEXT PRIMARY KEY,
      refreshToken TEXT NOT NULL UNIQUE,
      accessTokenId TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauthAuthorizationCode (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      clientId TEXT NOT NULL,
      userId TEXT,
      scopes TEXT NOT NULL,
      redirectURI TEXT NOT NULL,
      codeChallenge TEXT,
      codeChallengeMethod TEXT,
      expiresAt TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauthConsent (
      id TEXT PRIMARY KEY,
      clientId TEXT NOT NULL,
      userId TEXT NOT NULL,
      scopes TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      consentGiven INTEGER NOT NULL DEFAULT 0
    );
  `);

  console.log('[Auth] In-memory database initialized');
  return client;
}

// --- Auth Instance ---

function getAuth(): Auth {
  if (!auth) {
    throw new Error('Auth not initialized. Call mountAuthRoutes first.');
  }
  return auth;
}

async function initAuth(serverUrl: string): Promise<Auth> {
  const client = await createDatabase();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dialect = new LibsqlDialect({ client: client as any });

  auth = betterAuth({
    baseURL: serverUrl,
    secret: process.env.BETTER_AUTH_SECRET ?? randomBytes(32).toString('hex'),
    database: { dialect, type: 'sqlite' } as unknown as BetterAuthOptions['database'],
    trustedOrigins: [serverUrl],
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    plugins: [
      mcp({
        loginPage: '/sign-in',
        resource: `${serverUrl}/mcp`,
        oidcConfig: {
          loginPage: '/sign-in',
          codeExpiresIn: 600,
          accessTokenExpiresIn: 3600,
          refreshTokenExpiresIn: 604_800,
          defaultScope: 'openid',
          scopes: ['openid', 'profile', 'email', 'offline_access'],
          allowDynamicClientRegistration: true,
          metadata: {
            scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
          },
        },
      }),
    ],
  } satisfies BetterAuthOptions);

  console.log('[Auth] OAuth server initialized');
  console.log(`[Auth]   Demo user: ${DEMO_USER.email}`);

  return auth;
}

async function ensureDemoUser(): Promise<void> {
  if (demoUserCreated) return;

  const a = getAuth();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (a.api as any).signUpEmail({
      body: { email: DEMO_USER.email, password: DEMO_USER.password, name: DEMO_USER.name },
    });
    console.log('[Auth] Demo user created');
    demoUserCreated = true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('already') || msg.includes('exists') || msg.includes('unique')) {
      demoUserCreated = true;
    } else {
      throw error;
    }
  }
}

// --- Route Mounting ---

/**
 * Mounts all OAuth routes on the Express app.
 * MUST be called BEFORE `express.json()` middleware because
 * better-auth's `toNodeHandler` reads the raw request body.
 */
export async function mountAuthRoutes(app: Express, serverUrl: string): Promise<void> {
  const authInstance = await initAuth(serverUrl);

  // Rate limiters for auth endpoints — prevent brute-force and flooding
  const authLimiter = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'too_many_requests', error_description: 'Rate limit exceeded. Try again later.' },
  });
  const signInLimiter = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'too_many_requests', error_description: 'Rate limit exceeded. Try again later.' },
  });

  // better-auth API routes: authorize, token, register (DCR), revoke, etc.
  app.all('/api/auth/{*splat}', authLimiter, toNodeHandler(authInstance));

  // OAuth Authorization Server Metadata (RFC 8414)
  app.options('/.well-known/oauth-authorization-server', cors());
  app.get(
    '/.well-known/oauth-authorization-server',
    cors(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toNodeHandler(oAuthDiscoveryMetadata(authInstance as any)),
  );

  // Protected Resource Metadata (RFC 9728)
  // Mount at both the RFC 9728 derived path (/mcp suffix) and the bare path
  // for clients that don't yet know the resource identifier.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prmHandler = toNodeHandler(oAuthProtectedResourceMetadata(authInstance as any));
  for (const prmPath of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
    app.options(prmPath, cors());
    app.get(prmPath, cors(), prmHandler);
  }

  // Auto-login sign-in page (creates demo user session, redirects to authorize)
  app.get('/sign-in', signInLimiter, async (req: Request, res: Response) => {
    const params = new URLSearchParams(req.query as Record<string, string>);
    const redirectUri = params.get('redirect_uri');
    const clientId = params.get('client_id');

    if (!redirectUri || !clientId) {
      res.status(400).json({ error: 'Missing required OAuth parameters (redirect_uri, client_id)' });
      return;
    }

    try {
      await ensureDemoUser();

      const signInResponse = await authInstance.api.signInEmail({
        body: { email: DEMO_USER.email, password: DEMO_USER.password },
        asResponse: true,
      });

      // Forward session cookies so the authorize endpoint sees an active session
      for (const cookie of signInResponse.headers.getSetCookie()) {
        res.append('Set-Cookie', cookie);
      }

      // Redirect back to authorize with original OAuth parameters
      const authorizeUrl = new URL('/api/auth/mcp/authorize', serverUrl);
      authorizeUrl.search = params.toString();
      res.redirect(authorizeUrl.toString());
    } catch (error) {
      console.error('[Auth] Sign-in failed:', error);
      res.status(500).json({ error: 'Authentication failed' });
    }
  });

  console.log('[Auth] OAuth routes mounted:');
  console.log('  GET    /.well-known/oauth-authorization-server');
  console.log('  GET    /.well-known/oauth-protected-resource[/mcp]');
  console.log('  ALL    /api/auth/*');
  console.log('  GET    /sign-in');
}

// --- Token Verification ---

async function verifyAccessToken(token: string): Promise<{
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt: number;
}> {
  const a = getAuth();
  const headers = new Headers();
  headers.set('Authorization', `Bearer ${token}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const session = await (a.api as any).getMcpSession({ headers });
  if (!session) {
    throw new Error('Invalid token');
  }

  const scopes = typeof session.scopes === 'string' ? session.scopes.split(' ') : ['openid'];
  const expiresAt = session.accessTokenExpiresAt
    ? Math.floor(new Date(session.accessTokenExpiresAt).getTime() / 1000)
    : Math.floor(Date.now() / 1000) + 3600;

  return { token, clientId: session.clientId, scopes, expiresAt };
}

// --- Bearer Auth Middleware ---

/**
 * Express middleware that requires a valid Bearer token.
 * Returns 401 with `WWW-Authenticate` header pointing to the PRM endpoint
 * so clients can discover the authorization server via dynamic discovery.
 */
export function requireBearerAuth(
  options: { requiredScopes?: string[]; resourceMetadataUrl?: URL } = {},
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const { requiredScopes = [], resourceMetadataUrl } = options;

  const buildWwwAuth = (code: string, message: string): string => {
    let header = `Bearer error="${code}", error_description="${message}"`;
    if (requiredScopes.length > 0) {
      header += `, scope="${requiredScopes.join(' ')}"`;
    }
    if (resourceMetadataUrl) {
      header += `, resource_metadata="${resourceMetadataUrl.toString()}"`;
    }
    return header;
  };

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      res.set('WWW-Authenticate', buildWwwAuth('invalid_token', 'Missing Authorization header'));
      res.status(401).json({ error: 'invalid_token', error_description: 'Missing Authorization header' });
      return;
    }

    try {
      const authInfo = await verifyAccessToken(authHeader.slice(7));

      if (requiredScopes.length > 0 && !requiredScopes.every(s => authInfo.scopes.includes(s))) {
        res.set(
          'WWW-Authenticate',
          buildWwwAuth('insufficient_scope', `Required: ${requiredScopes.join(', ')}`),
        );
        res.status(403).json({
          error: 'insufficient_scope',
          error_description: `Required scopes: ${requiredScopes.join(', ')}`,
        });
        return;
      }

      req.app.locals.auth = authInfo;
      next();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Invalid token';
      res.set('WWW-Authenticate', buildWwwAuth('invalid_token', msg));
      res.status(401).json({ error: 'invalid_token', error_description: msg });
    }
  };
}
