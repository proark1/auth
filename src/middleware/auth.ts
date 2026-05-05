import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyAccessToken, verifyServiceToken } from '../crypto/signing.js';
import { AppError } from './errors.js';

export interface AuthedUser {
  id: string;
  email: string | undefined;
  emailVerified: boolean;
  roles: string[];
  orgId: string | undefined;
}

export interface AuthedService {
  clientId: string;
  scopes: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthedUser;
    service?: AuthedService;
  }
}

export async function requireUser(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    throw new AppError(401, 'unauthorized', 'missing bearer token');
  }
  const token = auth.slice('Bearer '.length).trim();
  if (!token) {
    throw new AppError(401, 'unauthorized', 'missing bearer token');
  }

  let claims;
  try {
    claims = await verifyAccessToken(token);
  } catch {
    throw new AppError(401, 'unauthorized', 'invalid or expired token');
  }

  if (claims.typ !== 'access') {
    throw new AppError(401, 'unauthorized', 'wrong token type');
  }

  req.user = {
    id: claims.sub,
    email: claims.email,
    emailVerified: claims.email_verified ?? false,
    roles: claims.roles ?? [],
    orgId: claims.org_id,
  };
}

// Convenience accessor for handlers that ran behind requireUser. Throws if used
// without the middleware — defense in depth against route mis-wiring.
export function currentUser(req: FastifyRequest): AuthedUser {
  if (!req.user) {
    throw new AppError(401, 'unauthorized', 'not authenticated');
  }
  return req.user;
}

// Service-token equivalent of requireUser. Rejects user tokens — services
// must use the client_credentials grant to get a typ='service' token.
export async function requireService(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    throw new AppError(401, 'unauthorized', 'missing bearer token');
  }
  const token = auth.slice('Bearer '.length).trim();
  if (!token) {
    throw new AppError(401, 'unauthorized', 'missing bearer token');
  }

  let claims;
  try {
    claims = await verifyServiceToken(token);
  } catch {
    throw new AppError(401, 'unauthorized', 'invalid or expired token');
  }

  if (claims.typ !== 'service') {
    throw new AppError(401, 'unauthorized', 'wrong token type');
  }

  req.service = {
    clientId: claims.sub,
    scopes: (claims.scope ?? '').split(' ').filter(Boolean),
  };
}

export function currentService(req: FastifyRequest): AuthedService {
  if (!req.service) {
    throw new AppError(401, 'unauthorized', 'not a service caller');
  }
  return req.service;
}

// Like requireService, but lets the request through when no token is present
// or the token is invalid. Used by endpoints that stay public (register,
// password/forgot) but use an attached service identity for branding.
export async function attachServiceIfPresent(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return;
  const token = auth.slice('Bearer '.length).trim();
  if (!token) return;

  try {
    const claims = await verifyServiceToken(token);
    if (claims.typ !== 'service') return;
    req.service = {
      clientId: claims.sub,
      scopes: (claims.scope ?? '').split(' ').filter(Boolean),
    };
  } catch {
    // Silent: this header may belong to a user token, or be malformed.
    // Public endpoints don't reject; per-client branding just falls back.
  }
}
