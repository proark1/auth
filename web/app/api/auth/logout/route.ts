import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/api';
import { ACCESS_COOKIE, REFRESH_COOKIE, clearedCookie } from '@/lib/cookies';

export async function POST(): Promise<Response> {
  const jar = await cookies();
  const access = jar.get(ACCESS_COOKIE)?.value;
  const refresh = jar.get(REFRESH_COOKIE)?.value;

  // Revoke server-side session before clearing cookies. Best-effort: if the
  // upstream call fails (network blip, expired access token, already revoked)
  // still clear local cookies so the user is signed out client-side.
  if (access && refresh) {
    try {
      await auth.logout(access, refresh);
    } catch {
      // intentionally swallowed — see comment above
    }
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(clearedCookie(ACCESS_COOKIE));
  res.cookies.set(clearedCookie(REFRESH_COOKIE));
  return res;
}
