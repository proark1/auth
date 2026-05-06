// Tiny JWT *decoder* (no signature verification). Safe for Edge + Node runtimes.
//
// Used only as a UX hint — to read claims like `roles` / `email` / `exp` from the
// access-token cookie before deciding which page/route to send the user to.
// All authoritative checks happen on the Fastify backend via `Authorization: Bearer`,
// which fully verifies the signature against JWKS.
//
// IMPORTANT: do NOT use this to authorize server-side mutations. Treat any value
// here as untrusted until the backend rejects/accepts the bearer.

export interface AccessClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  roles?: string[];
  exp?: number;
  iat?: number;
}

export function decodeAccessToken(token: string | undefined): AccessClaims | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const json = base64UrlDecode(parts[1]!);
    const obj = JSON.parse(json) as AccessClaims;
    if (typeof obj.sub !== 'string') return null;
    return obj;
  } catch {
    return null;
  }
}

export function isExpired(claims: AccessClaims | null): boolean {
  if (!claims?.exp) return true;
  return claims.exp * 1000 <= Date.now();
}

export function isAdmin(claims: AccessClaims | null): boolean {
  return !!claims?.roles?.includes('admin');
}

function base64UrlDecode(input: string): string {
  let s = input.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4 !== 0) s += '=';
  // atob is available in both Node 18+ and the Edge runtime.
  const binary = atob(s);
  // Decode the binary string as UTF-8.
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
