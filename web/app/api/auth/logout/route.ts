import { NextResponse } from 'next/server';
import { ACCESS_COOKIE, REFRESH_COOKIE, clearedCookie } from '@/lib/cookies';

export async function POST(): Promise<Response> {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(clearedCookie(ACCESS_COOKIE));
  res.cookies.set(clearedCookie(REFRESH_COOKIE));
  return res;
}
