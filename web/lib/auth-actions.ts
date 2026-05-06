'use server';

import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { auth, ApiError } from './api';
import { ACCESS_COOKIE, REFRESH_COOKIE, clearedCookie } from './cookies';

// Forwards the current bearer to the API to revoke the server-side session,
// then unconditionally clears local cookies. Used by the dashboard "Sign out"
// button (a <form action={logoutAction}>).
export async function logoutAction() {
  const jar = await cookies();
  const accessToken = jar.get(ACCESS_COOKIE)?.value;
  const refreshToken = jar.get(REFRESH_COOKIE)?.value;

  if (accessToken && refreshToken) {
    try {
      await auth.logout(accessToken, refreshToken);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
    }
  }

  jar.set(clearedCookie(ACCESS_COOKIE));
  jar.set(clearedCookie(REFRESH_COOKIE));
  redirect('/');
}
