import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyAccessToken } from '../crypto/signing.js';
import { AppError } from './errors.js';

export interface AuthedUser {
  id: string;
  email: string | undefined;
  emailVerified: boolean;
  roles: string[];
  orgId: string | undefined;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthedUser;
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
