import { NextResponse, type NextRequest } from 'next/server';
import { ACCESS_COOKIE } from '@/lib/cookies';
import { decodeAccessToken, isAdmin, isExpired } from '@/lib/jwt';

// Edge-runtime UX guard. Decodes (does NOT verify) the access-token cookie to
// route users to a sensible page; backend re-verifies on every API call.
//
//  - /dashboard|/admin without a valid-looking cookie → /login?next=…
//  - /admin/* but token has no 'admin' role          → /dashboard
//  - /login | /register while already logged in     → /dashboard or /admin
export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const token = req.cookies.get(ACCESS_COOKIE)?.value;
  const claims = decodeAccessToken(token);
  const loggedIn = !!claims && !isExpired(claims);
  const admin = loggedIn && isAdmin(claims);

  const isProtected = pathname.startsWith('/dashboard') || pathname.startsWith('/admin');
  if (isProtected && !loggedIn) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  if (pathname.startsWith('/admin') && !admin) {
    const url = req.nextUrl.clone();
    url.pathname = '/dashboard';
    url.search = '';
    return NextResponse.redirect(url);
  }

  if ((pathname === '/login' || pathname === '/register') && loggedIn) {
    const url = req.nextUrl.clone();
    url.pathname = admin ? '/admin' : '/dashboard';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/dashboard/:path*', '/admin/:path*', '/login', '/register'],
};
