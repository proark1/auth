import { NextResponse } from 'next/server';
import { auth, isMfaChallenge, ApiError } from '@/lib/api';
import { refreshCookie, accessCookie } from '@/lib/cookies';
import { decodeAccessToken, isAdmin } from '@/lib/jwt';

// Only redirect to paths inside the app — refuse open-redirect attempts.
function safeNext(next: string | null): string | null {
  if (!next) return null;
  if (!next.startsWith('/dashboard') && !next.startsWith('/admin')) return null;
  return next;
}

export async function POST(req: Request): Promise<Response> {
  let body: { email?: string; password?: string };
  try {
    body = (await req.json()) as { email?: string; password?: string };
  } catch {
    return NextResponse.json({ code: 'invalid_body' }, { status: 400 });
  }

  if (!body.email || !body.password) {
    return NextResponse.json({ code: 'missing_fields' }, { status: 400 });
  }

  const url = new URL(req.url);
  const requestedNext = safeNext(url.searchParams.get('next'));

  try {
    const result = await auth.login(body.email, body.password);

    if (isMfaChallenge(result)) {
      // Pass mfa_token back to the client so the form can collect a TOTP code.
      // No cookies set yet — only after MFA succeeds.
      return NextResponse.json({ mfa_required: true, mfa_token: result.mfa_token });
    }

    const claims = decodeAccessToken(result.access_token);
    const admin = isAdmin(claims);
    const fallback = admin ? '/admin' : '/dashboard';
    const redirectTo = requestedNext ?? fallback;

    const res = NextResponse.json({ ok: true, redirectTo });
    res.cookies.set(refreshCookie(result.refresh_token, new Date(result.refresh_token_expires_at)));
    res.cookies.set(accessCookie(result.access_token, result.expires_in));
    return res;
  } catch (err) {
    if (err instanceof ApiError) return NextResponse.json(err.body, { status: err.status });
    return NextResponse.json({ code: 'upstream_error' }, { status: 502 });
  }
}
