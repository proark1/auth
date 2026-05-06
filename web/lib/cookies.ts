import type { ResponseCookie } from 'next/dist/compiled/@edge-runtime/cookies';

export const REFRESH_COOKIE = 'mas_refresh';
export const ACCESS_COOKIE = 'mas_access';

const isProd = process.env.NODE_ENV === 'production';

const baseCookie: Partial<ResponseCookie> = {
  httpOnly: true,
  secure: isProd,
  sameSite: 'lax',
  path: '/',
};

export function refreshCookie(value: string, expiresAt: Date): ResponseCookie {
  return {
    ...baseCookie,
    name: REFRESH_COOKIE,
    value,
    expires: expiresAt,
  } as ResponseCookie;
}

export function accessCookie(value: string, expiresInSeconds: number): ResponseCookie {
  return {
    ...baseCookie,
    name: ACCESS_COOKIE,
    value,
    maxAge: expiresInSeconds,
  } as ResponseCookie;
}

export function clearedCookie(name: string): ResponseCookie {
  return {
    ...baseCookie,
    name,
    value: '',
    maxAge: 0,
  } as ResponseCookie;
}
