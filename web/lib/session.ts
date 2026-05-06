import 'server-only';
import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { ACCESS_COOKIE } from './cookies';
import { decodeAccessToken, isAdmin, isExpired, type AccessClaims } from './jwt';
import { ApiError, type ApiErrorBody } from './api';

export interface Session {
  userId: string;
  email: string | undefined;
  emailVerified: boolean;
  isAdmin: boolean;
  accessToken: string;
}

// Reads the access-token cookie and returns a best-effort session. Returns null
// if missing/expired/malformed. Decoded claims are NOT verified — for any
// authoritative call use the backend (it verifies the bearer).
export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const token = jar.get(ACCESS_COOKIE)?.value;
  if (!token) return null;
  const claims = decodeAccessToken(token);
  if (!claims || isExpired(claims)) return null;
  return claimsToSession(token, claims);
}

export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) redirect('/login');
  return s;
}

export async function requireAdminSession(): Promise<Session> {
  const s = await getSession();
  if (!s) redirect('/login');
  if (!s.isAdmin) redirect('/dashboard');
  return s;
}

function claimsToSession(token: string, claims: AccessClaims): Session {
  return {
    userId: claims.sub,
    email: claims.email,
    emailVerified: !!claims.email_verified,
    isAdmin: isAdmin(claims),
    accessToken: token,
  };
}

// Server-side fetcher that forwards the access-token cookie as Bearer to the
// upstream Fastify API. Throws ApiError on non-2xx so server components can
// surface a friendly message via Next's error boundary.
export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  opts: { accessToken?: string } = {},
): Promise<T> {
  const base = process.env.AUTH_API_URL;
  if (!base) throw new Error('AUTH_API_URL is not set');

  let token = opts.accessToken;
  if (!token) {
    const jar = await cookies();
    token = jar.get(ACCESS_COOKIE)?.value;
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(`${base.replace(/\/$/, '')}${path}`, {
    ...init,
    headers,
    cache: 'no-store',
  });

  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { code: 'upstream_non_json', message: text.slice(0, 200) };
    }
  }
  if (!res.ok) throw new ApiError(res.status, (body ?? {}) as ApiErrorBody);
  return body as T;
}
